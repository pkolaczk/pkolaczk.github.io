---
layout: post
title: Performance Impact of Parallel Disk Access
comments: true
excerpt_separator: <!--more-->
---

One of the well-known ways of speeding up a data processing task is partitioning the data into smaller
chunks and processing the chunks in parallel. Let's assume we can partition the task easily, or the input data is already 
partitioned into separate files which all reside on a single storage device. Let's also assume the algorithm we run on those
data is simple enough so that the computation time is not a bottleneck. How much performance can we gain by reading the files in parallel? 
Can we lose any?

<!--more-->

<script>
var colors = ["rgba(230,140,35,0.8)", "rgba(130,20,0,0.8)"]

function makeBarChart(id, labels, data) {   
    var ctx = document.getElementById(id).getContext('2d');
    var datasets = [];
    var colorIndex = 0;
    for (var series in data) {        
        datasets.push({
            label: series,
            backgroundColor: colors[colorIndex],        
            barPercentage: 0.6,
            data: data[series],
        });
        colorIndex++;
    }

    new Chart(ctx, {
        type: 'horizontalBar',
        data: {
            labels: labels,
            datasets: datasets,
        },
        options: {
            maintainAspectRatio: false,
            legend: { display: Object.keys(data).length  > 1 },
            scales: {
                yAxes: [{
                    scaleLabel: { 
                        display: true,
                        labelString: "# threads",
                    },
                }],
                xAxes: [{
                    scaleLabel: { 
                        display: true,
                        labelString: "time [s]",
                    },
                    ticks: {
                        beginAtZero: true
                    }
                }]
            }    
        }
    });
}    

function makeBarChartDeferred(id, labels, data) {
    document.addEventListener('readystatechange', event => {
        if (event.target.readyState === "complete") {
            makeBarChart(id, labels, data);
        }
    });      
}

</script>

While working on [fclones](https://github.com/pkolaczk/fclones) duplicate file finder,
I've put a lot of effort into making it as fast as possible by leveraging capabilities of modern hardware.
That's why I designed my program in a way that all data processing stages can be easily parallelized. 
The newest version at the moment of writing this post (0.7.0) allows to set thread pools for random I/O 
and sequential I/O separately, and can adapt the settings to different types of storage devices.

In this blog post I'm presenting the results of a few experiments I've made separately on SSD and HDD.
All the experiments were perfomed on either a Dell Precision 5520 laptop with a 4-core Xeon and a 512 NVMe SSD, from 2016, 
running Ubuntu Linux 20.04, or an older Dell M4600 with a 7200 RPM Toshiba HDD running Mint Linux 19.03.

# SSD – Metadata and Random Reads
The most time-consuming part of the job is actually reading
the data from disk into memory in order to compute hashes. The number of files is typically large (thousands or even millions) 
and the problem of computing their hashes is embarrassingly parallel. 
The first thing my duplicate finder does is scanning directory tree and fetching file metadata like file lenghts and inode identifiers. 
This process issues a lot of random I/O requests. As expected, the performance gains from multithreading were huge, 
which is illustrated in Fig.&nbsp;1.

<div class="figure">
    <div style="height:12.5em"><canvas id="scanPerfSsd"></canvas></div>
    <script>
    makeBarChartDeferred("scanPerfSsd", 
        [1, 2, 4, 8, 16, 32],
        {"time": [40.38, 19.18, 9.85, 5.74, 4.155, 3.64]});
    </script>
    <span class="caption"> Fig.1: Time to fetch metadata of ~1.5 million file entries on an SSD</span>
</div>

In the next stage, the files matching by size are compared by hashes of their initial 4 kB block. This involves a lot of random I/O as well – 
for each file, `fclones` opens it, reads the first 4 kB of data, computes the hash and closes the file, then moves to the next file. 
SSDs are great at random I/O, and high parallelism level leads to big wins here as well (Fig.&nbsp;2). It was surprising to me
that even 64 threads, which are far more than the number of CPU cores (4 physical, 8 virtual), still improved the performance.
I guess that with requests of such a small size to such a fast storage, you need to submit really many of them to keep 
the SSD busy.

<div class="figure">
    <div style="height:14em"><canvas id="prefixHashPerfSsd"></canvas></div>
    <script>
    makeBarChartDeferred("prefixHashPerfSsd", 
        [1, 2, 4, 8, 16, 32, 64], 
        {"time": [198, 88.5, 40.1, 23.0, 10.75, 6.69, 5.43]});
    </script>
    <span class="caption"> Fig.2: Time to hash initial blocks of ~1.2 million files on an SSD</span>
</div>

Let's look at `iostat`. With only 1 thread, `iostat` reports CPU to be mostly idle, but
the SSD utilization is at 100%. 

<pre>
avg-cpu:  %user   %nice %system %iowait  %steal   %idle
           2,39    0,00    5,03    5,03    0,00   87,55

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz   aqu-sz  %util
nvme0n1       5458,00     21,32     0,00   0,00    0,11     4,00     0,00 100,00
</pre>

Does it mean the SSD is already at its 100% performance? No, because 
`%util` is calculated as the ratio of *wall clock time* the device is serving requests. 
This doesn't account for effects of submitting multiple requests at the same time.
It looks like my SSD is very happy to receive more load. With 64 threads,
`%util` is still at 100%, but the served read request rate went up by over 40 times:

<pre>
avg-cpu:  %user   %nice %system %iowait  %steal   %idle
          28,46    0,00   66,92    4,62    0,00    0,00

Device            r/s     rMB/s   rrqm/s  %rrqm r_await rareq-sz   aqu-sz  %util
nvme0n1     223974,00    874,90     0,00   0,00    0,17     4,00     0,00 100,00
</pre>

BTW: why the average queue size `aqu-sz` remains 0,00 even under 64 threads remain a mystery to me. 
Feel free to drop any clues in the comments.

How do I known the CPU is not the main bottleneck here then? The CPU load numbers given by `iostat` are pretty high, aren't they?
I measured how much time it takes to do the task when all the data were cached, by running it again, without prior dropping caches. 
When all cached, the metadata scanning took 1.5&nbsp;s and the partial hashing took 1.7&nbsp;s. This is still
significantly faster than when physical reads were involved, so nope, 
I/O is still the major bottleneck, even with 64 threads. 

# SSD – Sequential Reads

And what about the sequential I/O reads? Does parallelizing the sequential I/O improve speed as well?
It looks like it does, although not by as much as for random I/O (Fig.&nbsp;3).
The last stage of `fclones` algorithm is hashing full files – in this experiment the files were mostly JPG and RAW images, 
about 10 MB large on average. Gains seem to hit a plateau a bit earlier – after 8 threads. In this case the operating 
system has an opportunity to prefetch data, so
it can keep the SSD busy even when my application is not asking for data for a while. 

<div class="figure">
    <div style="height:14em"><canvas id="fullHashPerfSsd"></canvas></div>
    <script>
    makeBarChartDeferred("fullHashPerfSsd", 
            [1, 2, 4, 8, 16, 32, 64],
            {"time": [74.3, 33.74, 20.1, 16.75, 15.45, 15.20, 15.15]});
    </script>
    <span class="caption"> Fig. 3: Time to hash 21.6 GB of data read from an SSD in function of number of threads</span>
</div>

# HDD – Random Reads
Contrary to an SSD, a spinning drive has a large seek-latency and it can serve I/O requests
at much lower rate. Hence, we can definitely expect random I/O to be much slower on an HDD than on an SSD. 
But can we expect any performance gains from reading in parallel? 
My initial thought was there shouldn't be any visible gains, because a single HDD can only serve 
a single read request at a given time, then it has to reposition the heads to "jump" to another file, and 
this looks very "sequentially" in principle. Having a large number of requests piled up in the queue 
shouldn't change anything: the HDD would handle them in a sequence anyways. 
An HDD is also slow enough that even a single fast thread should keep it fully busy with at 
least one request ready to serve at any time.

I was wrong. It turns out that for small, random I/O requests there are noticeable gains from parallelism 
even on an HDD (Fig. 4). But this happens for a different reason than on SSD. 
The seek latency depends heavily on the *order* of the I/O requests. If the process submits more
I/O requests from multiple threads, the operating system can *reorder* them by physical data location, thus minimizing
the distance the HDD heads have to travel.

<div class="figure">
    <div style="height:14em"><canvas id="partialHashPerfHdd"></canvas></div>
    <script>
    makeBarChartDeferred("partialHashPerfHdd", 
            [1, 2, 4, 8, 16, 64, 256],
            {"time": [681.92, 358.34, 316.53, 276.68, 245.06, 225.99, 227.40]});
    </script>
    <span class="caption"> Fig.4: Time to hash initial blocks of 46,165 files on a 7200 RPM HDD</span>
</div>

# HDD – Sequential Reads
Unfortunately, when reading larger chunks of data sequentially, using multi-threding actually hurts the throughput (Fig.&nbsp;5).
This is because the operating system interleaves the I/O requests coming from different threads and the HDD would have
to reposition the heads frequently jumping from one file to another. How much throughput is lost depends heavily on the operating
system and its configuration, but generally I'd expect this to be a factor 2x-10x.

<div class="figure">
    <div style="height:18em"><canvas id="fullHashPerfHdd"></canvas></div>
    <script>
    makeBarChartDeferred("fullHashPerfHdd", 
            [1, 2, 4, 8, 16, 64], 
            {"fadvise": [24.131, 54.59, 48.44, 45.114, 42.54, 42.102], 
             "no fadvise": [24.193, 67.835, 51.237, 53.45, 53.99, 52.24]});
    </script>
    <span class="caption"> Fig.5: Time to hash 1.7 GB of data on a 7200 RPM HDD</span>
</div>

One way of solving this problem in an application is to not allow many threads to contend for the same HDD device at the OS level, and 
instead make the application take some control over the I/O request scheduling by itself.
You can use a dedicated single thread to handle all I/O to a single spinning drive (this is what `fclones` does since version 0.7.0),
or guard I/O operations by a critical section (mutex) associated with each HDD and locked at a granularity coarse enough that
seek time doesn't matter. I don't recommend making the whole application single-threaded, because that would disallow
issuing parallel requests to multiple devices and it wouldn't allow the gains outlined above.

Additionally, many operating systems allow to tell the kernel that the application will be reading the file data sequentially. 
For example in Linux, after opening the file, just call [`posix_fadvise`](https://man7.org/linux/man-pages/man2/posix_fadvise.2.html) with `POSIX_FADV_SEQUENTIAL`:

```rust
use std::fs::*;
use nix::fcntl::*;
let file = File::open("foo.txt")?;
let errno = posix_fadvise(file.as_raw_fd(), 0, 0, PosixFadviseAdvice::POSIX_FADV_SEQUENTIAL)?;
```

Internally this option increases the size of the read-ahead buffer, so the system can fetch data in larger chunks, 
potentially reducing the number of seeks. The effects of this flag are clearly visible and it improves performance of parallel access, 
but it is not strong enough to reduce the seek overhead to zero. Interestingly, I haven't observed any effects 
of this flag on single-threaded throughput in my test, but YMMV. 

# Conclusions
- Random I/O and reading metadata benefits from parallelism on both types of drives: SSD and HDD
- SSDs generally benefit from parallelism much more than HDDs
- Parallel access to HDD when reading large chunks of data sequentially can deteriorate performance 
- Calling `posix_fadvise` to inform the system about sequential access pattern improves read throughput slightly
  when sharing the device between multiple threads on Linux

