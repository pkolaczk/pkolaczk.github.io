---
layout: post
title: Performance Impact of Parallel Disk Access
excerpt_separator: <!--more-->
---

<script>
function makeBarChart(id, labels, data) {
    var ctx = document.getElementById(id).getContext('2d');
    new Chart(ctx, {
        type: 'horizontalBar',
        data: {
            labels: labels,
            datasets: [{
                label: 'time [s]',
                backgroundColor: "rgba(230,140,35,0.8)",        
                barPercentage: 0.6,
                data: data,
            }]
        },
        options: {
            maintainAspectRatio: false,
            legend: { display: false },
            scales: {
                xAxes: [{
                    ticks: {
                        beginAtZero: true
                    }
                }]
            }
        }
    });
}    
</script>


One of the well-known ways of speeding up a data processing task is partitioning the data into smaller
chunks and processing the chunks in parallel. Let's assume we can partition the task easily, or the input data is already 
partitioned into separate files which all reside on a single storage device. Let's also assume the algorithm we run on those
data is simple enough so that the computation time is not a bottleneck. How much performance can we gain by reading the files in parallel? 
Can we lose any?

<!--more-->

# SSD

When I started working on [fclones](https://github.com/pkolaczk/fclones) duplicate file finder,
I wanted to make it as fast as possible by leveraging capabilities of modern hardware. 
I've got a pretty solid Dell Precision 5520 laptop with a 4-core Xeon and a 512 NVMe SSD, from 2016, 
running Ubuntu 20.04.
Quite likely I could get a faster machine today, but anyways it should be probably modern enough to draw 
a few useful conclusions about I/O performance on SSD.

The most time-consuming part of the job is actually reading
the data from disk into memory in order to compute hashes. The number of files is typically large (thousands or even millions) 
and the problem of computing their hashes is embarassingly parallel. Scheduling work on multiple threads seemed like the right move. 
Before writing the whole code, I did a few quick checks with scanning directory tree and fetching file metadata, and, as expected, the performance
gains from multithreading were huge, which is illustrated in Fig. 1.

<div class="figure">
    <div style="height:12.5em"><canvas id="scanPerfSsd"></canvas></div>
    <script>
    makeBarChart("scanPerfSsd", 
        [1, 2, 4, 8, 16, 32],
        [40.38, 19.18, 9.85, 5.74, 4.155, 3.64]);
    </script>
    <span class="caption"> Fig.1: Time to fetch metadata of ~1.5 million file entries on an SSD in function of number of threads</span>
</div>

In the next stage, the files matching by size are compared by hashes of their initial 4 kB block. This involves a lot of random I/O – 
for each file, it opens it, reads first 4 kB of data, computes its hash and closes the file, then moves to the next file. 
SSDs are great at random I/O, and high parallelism level leads to big wins here as well (Fig. 2). It was surprising to me
that even 64 threads, which are far more than the number of CPU cores (4 physical, 8 virtual), still improved the performance.
I guess that with requests of such a small size to such a fast storage, you need to submit really many of them to keep 
the SSD busy.

<div class="figure">
    <div style="height:14em"><canvas id="prefixHashPerfSsd"></canvas></div>
    <script>
    makeBarChart("prefixHashPerfSsd", 
        [1, 2, 4, 8, 16, 32, 64], 
        [198, 88.5, 40.1, 23.0, 10.75, 6.69, 5.43]);
    </script>
    <span class="caption"> Fig.2: Time to hash initial blocks of ~1.2 million files on an SSD in function of number of threads</span>
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

BTW: why the average queue size `aqu-sz` remains 0,00 even uder 64 threads remain a mystery to me. 
Feel free to drop any clues in the comments.

How do I known the CPU is not the main bottleneck here then? The CPU load numbers given by `iostat` are pretty high, aren't they?
I measured how much time it takes to do the task when all the data were cached, by running it again, without prior dropping caches. 
When all cached, the metadata scanning took 1.5 s and the partial hashing took 1.7 s. This is still
significantly faster than when physical reads were involved, so nope, 
I/O is still the major bottleneck, even with 64 threads. 

And what about the sequential I/O reads? Does parallelizing the sequential I/O improve speed as well?
It looks like it does, although not by as much as for random I/O (Fig. 3).
Gains seem to hit a plateau a bit earlier – after 8 threads. In this case the operating system has an opportunity to prefetch data, so
it can keep the SSD busy even when my application is not asking for data for a while. 

<div class="figure">
    <div style="height:14em"><canvas id="fullHashPerfSsd"></canvas></div>
    <script>
    makeBarChart("fullHashPerfSsd", 
            [1, 2, 4, 8, 16, 32, 64],
            [74.3, 33.74, 20.1, 16.75, 15.45, 15.20, 15.15]);
    </script>
    <span class="caption"> Fig.3: Time to hash 21.6 GB of data read from an SSD in function of number of threads</span>
</div>

# HDD

# Conclusions
- Random I/O and reading metadata benefits from parallelism on both types of drives: SSD and HDD
- Avoid parallel access on HDD when reading large chunks of data sequentially
- SSDs generally benefit from parallelism much more than HDDs









