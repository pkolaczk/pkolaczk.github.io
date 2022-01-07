---
layout: post
title: Ordering Requests to Accelerate Disk I/O
comments: true
tags: performance, optimization, Rust, HDD, spinning drive
excerpt_separator: <!--more-->
---

In [the earlier post]({% post_url 2020-08-24-disk-parallelism %}) I showed how accessing data on
an SSD in parallel can greatly improve read performance. However, that technique
is not very effective for data stored on spinning drives. In some cases parallel access
can even deteriorate performance significantly. Fortunately, there exists a class of optimizations
that can strongly help with HDDs: request ordering. By requesting data in proper order,
the disk seek latency can be reduced by an order of magnitude. Since I introduced that 
optimization in [fclones 0.9](https://github.com/pkolaczk/fclones), `fclones` became the 
fastest duplicate file finder I know of.

<!--more-->


# HDD Performance Characteristics

Spinning drives, contrary to SSDs, have significant access latency, limiting the effective
number of IO operations per second they can serve. The disk access latency is mostly comprised of:
* seek latency – the time needed to position the head on the desired track, 
* rotational latency – the time needed to wait for the disk to rotate so that the right sector is under the head,

The seek latency is higher the more distance the head has to move to get to the right track. 
The typical average seek latency advertised by manufacturers are about 5-12 ms. 
The average rotational latency is equal to the time needed for the disk plates to do half of the turn.
In case of a 7200 RPM drive, this equals to 60/7200/2 = 4.2 ms. Overall the total average 
latency can be about 10 ms, and worst-case latency more than 20 ms.

Now if we want to process a bunch of tiny files placed randomly on the disk, and we access them in random
order, we should not expect to process vastly more than about 100 per second 
(you might get lucky though, that some of your files would be located close to each other which may improve it a bit).

This back-of-the envelope calculation holds pretty well in the real world. 
Here is an example `iostat` output while searching for duplicates
on a 7200 RPM HDD with an old version of `fclones` (0.8):

<pre>
Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda             127,40       655,20         0,00       3276          0
sdb               0,60         0,00        67,20          0        336

Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda             135,00       659,20         0,00       3296          0
sdb              26,00         0,00       174,40          0        872

Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda             132,60       669,60         0,00       3348          0
sdb               0,40         0,00         8,00          0         40

Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda             127,40       683,20         0,00       3416          0
sdb               0,40         2,40        28,00         12        140
</pre>

We can see the number of transactions per second (`tps`) is slightly more than 100. That's a 
ridiculously low number considering SSDs can handle tens or even hundreds thousands random accesses 
per second. The data rate is also essentially "killed" by latency. This drive can read at more than
100 MB/s continuously, but here we get a rate in the range of hundreds of kilobytes.

Unfortunately, even in 2021 you may still have plenty of gigabytes in small files lying 
around on older HDDs. Does it mean you're doomed to hours of waiting if you ever want to 
process all of them (e.g. search, backup or deduplicate)? 

# Basic Request Ordering 

In [[1]](Lunde2009) the authors presented some nice techniques of improving performance by sorting I/O requests before
sending them to the operating system for execution. I implemented them in `fclones` and the results are
truly amazing! 

Up to version 0.8, `fclones` processed files in the order dictated by their *size*, because that was the order
naturally obtained from the first phase of grouping. As you may expect, it turns out, 
file size isn't correlated with the physical location of a file at all. Hence, the performance on HDD was actually
worse than as if the files were processed in the order obtained from scanning the directory tree. 
At least, when processing files in the order returned by the directory listing, there are high 
chances they were saved at the similar time (e.g. as a result of a directory copy operation) and are actually
placed very close to each other. And indeed,
some alternative programs like `fdupes` or `rdfind` outperformed `fclones` on HDD, despite not really doing anything special
to speed up disk access. 

One of the first ideas I tried from the paper was to reorder the files by their inode identifiers. 
This was quite easy, because the inode identifiers were available already in the file metadata structures in order to properly detect
hard-links. Honestly, I wasn't expecting much improvement from this technique, as theoretically the inode number of a file
has nothing to do with the physical data location. 
In practice though, there seems to be a lot of correlation. This technique alone worked like a charm, despite some minor added cost
of sorting the entries! 

<script type="text/javascript" src="/assets/graphs/graphs.js"></script>

<div class="figure">
    <div style="height:7em">
        <canvas id="inodeOrdering"></canvas>
    </div>
    <script>
    makeBarChartDeferred("inodeOrdering", "time [s]", "ordering",
        ["by size", "by inode"],
        {"time": [217, 28.43]});
    </script>
    <span class="caption"> Fig.1: Time to find duplicates among 50k+ files stored on a 7200 RPM drive</span>
</div>

# Ordering by Physical Data Location

We can do better. Some file systems, like Linux EXT4, offer an API for fetching information about file extents: `FIEMAP ioctl`.
We can use this API to get a data structure that contains information on the physical placement of the file data. 
Then, the physical placement of the beginning of the data can be used to sort the files so that we can process
all files in a single sweep. A great news is that this API is also available for non-root users.

Using `FIEMAP` in Rust is easy, because there is already a Rust crate for that: [`fiemap`](https://crates.io/crates/fiemap). 
The relevant fragment of `fclones` code looks like this:

```rust
#[cfg(target_os = "linux")]
pub fn get_physical_file_location(path: &Path) -> io::Result<Option<u64>> {
    let mut extents = fiemap::fiemap(&path.to_path_buf())?;
    match extents.next() {
        Some(fe) => Ok(Some(fe?.fe_physical)),
        None => Ok(None),
    }
}
```

I was initially worried that an additional system call for every file would add some initial cost, canceling the gains
from the access ordering. Fortunately it turned out the cost was really low – 50k files could be queried for extents in less than
a second! I guess that the fact the metadata for the files were already queried in an earlier stage, so all the
required information was already in the cache. Fig. 2 shows that despite the higher number of system calls, 
the total time of the task decreased even more, down to about 19 seconds! This is over 10x faster than the earlier release.

<div class="figure">
    <div style="height:9em">
        <canvas id="fiemapOrdering"></canvas>
    </div>
    <script>
    makeBarChartDeferred("fiemapOrdering", "time [s]", "ordering",
        ["by size", "by inode", "by physical location"],
        {"time": [217, 28.43, 19.45]});
    </script>
    <span class="caption"> Fig.2: Impact of physical data ordering on time to find duplicates among 50k+ files stored on a 7200 RPM drive</span>
</div>

The number of transactions per second and throughput reported by `iostat` also went up considerably.
Many files are read now in a single disk plate turn.

<pre>
Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda            2424,40     11605,60         0,00      58028          0
sdb               1,00         4,80        11,20         24         56

Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda            2388,20     10436,80         0,00      52184          0
sdb               6,60       356,80        38,40       1784        192

Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn
sda            2397,00     11188,00         0,00      55940          0
sdb               3,20        80,80        56,80        404        284
</pre>

# Impact of Parallelism

Before introducing the reordering, I've found that issuing requests in parallel for reading small (4-64 kB) chunks of data improved speed.
The operating system definitely made a good use of knowing some files in advance and reordered accesses by itself. 
Is it still the case after we order the reads? Maybe giving the operating system a bit more requests in advance could still save some time? 
I thought the system could technically work on fetching the next file while the app is still processing the earlier one. 

Unfortunately, at least on my system, this seems to not work as I thought. Fetching files in parallel degraded performance a bit (Fig. 3). The effect
wasn't as huge as for sequential access of big files, but big enough that I changed the defaults in `fclones 0.9.1` to now use always a 
single-thread per HDD device. 


<div class="figure">
    <div style="height:9em">
        <canvas id="parallelAccess"></canvas>
    </div>
    <script>
    makeBarChartDeferred("parallelAccess", "time [s]", "# threads",
        [1, 2, 8],
        {"time": [19.45, 25.22, 29.11]});
    </script>
    <span class="caption"> Fig.3: Impact of parallelism on performance of ordered disk access</span>
</div>

# Summary

The order of file I/O requests has a tremendous impact on I/O performance on spinning drives.
If your application needs to process a batch of small files, make sure you request them in the 
same order as their physical placement on disk. If you can't do it because your file system
or your operating system does not provide physical block placement information, at least
sort the files by their identifiers. If you're lucky, the identifiers would be highly correlated
with the physical placement of data, and such ordering would still do some magic.

Please let me know in the comments if you tried this and how big improvements you've got.

# References
1. C. Lunde, H. Espeland, H. Stensland, and P. Halvorsen, “Improving File Tree Traversal Performance by Scheduling I/O Operations in User space,” Dec. 2009, pp. 145–152, doi: 10.1109/PCCC.2009.5403829.







