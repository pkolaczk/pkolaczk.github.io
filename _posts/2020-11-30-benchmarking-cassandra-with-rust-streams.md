---
layout: post
title: Scalable Benchmarking with Rust Streams
comments: true
tags: Rust, Cassandra, async, CQL driver, Tokio, Streams
excerpt_separator: <!--more-->
---

In [the previous post]({% post_url 2020-10-05-benchmarking-cassandra %}) I showed how to use asynchronous 
Rust to measure throughput and response times of a Cassandra cluster. 
That approach works pretty well on a developer's laptop, but it turned out it doesn't scale to bigger machines. 
I've hit a hard limit around 150k requests per
second, and it wouldn't go faster regardless of the performance of the server. 
In this post I share a different approach that doesn't have these scalability problems. 
I was able to saturate a 24-core single node Cassandra server
at 800k read queries per second with a single client machine.

<!--more-->

The original idea was based on a single-threaded loop that spawns asynchronous tasks.
Each task sends an async query, records its duration when the results are back, and sends the recorded


```rust
    let parallelism_limit = 1000;
    let semaphore = Arc::new(Semaphore::new(parallelism_limit));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let session = Arc::new(session);
    for i in 0..count {
        let mut statement = statement.bind();
        statement.bind(0, i as i64).unwrap();

        let session = session.clone();
        let tx = tx.clone();
        let permit = semaphore.clone().acquire_owned().await;
        tokio::spawn(async move {
            let query_start = Instant::now();
            let result = session.execute(&statement);
            result.await.unwrap();
            let query_end = Instant::now();
            let duration_micros = (query_end - query_start).as_micros();
            tx.send(duration_micros).unwrap();
            drop(permit);
        });
    }   
    drop(tx);

    // ... receive the durations from rx and compute statistics
```

I assumed invoking async queries should be so fast that the server would be the only bottleneck.
I was wrong. 

When running this code on a nice 24-core machine, I observed a surprising effect:
the benchmarking client managed to send about 120k read requests per second, but both the client and the server
machines had plenty of idle CPU available. 

# Tuning

The first idea to fix this was to play with the number of I/O threads used internally by the C++ Driver.
Susprisingly that didn't help a lot. While going from 1 to 4 I/O threads improved performance slightly to about 150k requests per second,
increasing this further didn't have much effect and going extreme to >32 threads actually even worsened the performance. 
I also didn't get much luckier by tuning the number of client connections per each I/O thread. 4-8 threads with 1 connection each
seemed to be a sweet spot, but very far from saturating the hardware I had.

The next thing that came to my mind was looking closer at Tokio setup.
Tokio allows to choose either a single-threaded scheduler or a multi-threaded one.
A single-threaded scheduler uses a single OS thread to run all async tasks.
Because I assumed the majority of hard work is supposed to be done by the Cassandra C++ driver code
and because the C++ driver comes with its own `libuv` based thread-pool, I initially set up Tokio with
a single-threaded scheduler. How costly could it be to count queries or compute the histogram of durations, anyways?
Should't it be easily in the range of millions of items per second, even on a single thread?

Indeed, counting queries seemed to be fast, but `perf` suggested the majority of time is being spent in two places:
- C++ Driver code
- Tokio runtime

So maybe that wasn't a good idea to use a single thread to run all the Tokio stuff? 
Here is the code for setting up Tokio with a multi-threaded scheduler:

```rust
async fn async_main() {
  // Run async benchmark code
}

fn main() {        
    tokio::runtime::Builder::new_multi_thread()
        .max_threads(8)    
        .enable_time()
        .build()
        .unwrap()
        .block_on(async_main());
}
```

This change alone without any modification to the main loop of the benchmark allowed to increase the performance
to about 220k requests per second. Obviously, this didn't satisfy me, because I knew these machines could go much faster.
Just running 3 instances of my Rust benchmarking program at the same time allowed to reach throughput of around 450k req/s.
And running 12 Java-based `cassandra-stress` clients, each from a separate node, made ~760k req/s. 

Additionally the change of the scheduler had a negative side effect: the CPU usage on the client
increased by about 50% and now in the other tests when running the benchmarking program on the same machine 
as the benchmarked server the performance was slightly worse than before. So, overall the benchmarking tool 
got slightly faster, but *less efficient*.

# Rethinking the Main Loop
There are several things that limit the speed at which new requests can be spawned:
- Spawning an async task in Tokio is quite costly - it requires adding the task to a shared queue
  and possibly some (lightweight) synchronization. 
- Each task sends the result to an mpsc channel. There is some contention there as well.
- The Tokio async semaphore also seems to add some overhead.
- Cloning the referenced-counted pointer to a shared session is another point of contention between threads.
- Finally, binding query parameters and sending the query also requires some CPU work.

As an experiment I removed all the calls related to sending Cassandra queries from the main loop,
and I got only ~800k loops per second, when benchmarking "nothing". This led me to thinking this code needs to be improved.

In the [comment](https://www.reddit.com/r/rust/comments/j5n04h/benchmarking_apache_cassandra_with_rust/g7vi6bi?utm_source=share&utm_medium=web2x&context=3) 
under the original blog post, [kostaw](https://www.reddit.com/user/kostaw/) suggested to use Streams instead
of manual looping. Below I present a version of code after minor modifications to make it compile:

```rust

/// Invokes count statements and returns a stream of their durations.
/// Note: this does *not* spawn a new thread. 
/// It runs all async code on the caller's thread.
fn make_stream<'a>(session: &'a Session, statement: &'a PreparedStatement, count: usize)
    -> impl Stream<Item=Duration> + 'a {

    let parallelism_limit = 128;
    futures::stream::iter(0..count)
        .map(move |i| async move {
            let mut statement = statement.bind();
            let statement = statement.bind(0, i as i64).unwrap();
            let query_start = Instant::now();
            let result = session.execute(&statement);
            result.await.unwrap();
            query_start.elapsed()
        })
        // This will run up to `parallelism_limit` futures at a time:
        .buffer_unordered(parallelism_limit)
}

async fn benchmark() {
    let count = 1000000;

    // Connect to the database and prepare the statement:
    let session = // ...
    let statement = session.prepare(/** statement */).unwrap().await.unwrap();
    let mut stream = make_stream(&session, &statement, count)

    // Process the received durations: 
    let benchmark_start = Instant::now();
    while let Some(duration) = stream.next().await {
        // ... optionally compute durations statistics
    }
    println!(
        "Throughput: {:.1} request/s",
        1000000.0 * count as f64 / benchmark_start.elapsed().as_micros() as f64
    );
}
```

There are several advantages to this approach:
- The code is simpler and much more elegant: no channels, no semaphore to limit parallelism
- We don't need `Arc` anymore to deal with lifetimes! Standard lifetime annotations are enough
  to tell Rust that `Session` lives at least as long as the `Stream` we return.
- There is no task spawning.

This code indeed has a much lower overhead. After removing the `statement.bind` and `session.execute` calls,
the stream was able to generate over 10 million items per second on my laptop. That's a nice 12x improvement.

Unfortunately, this way we only reduced some overhead, but the main scalability problem is still there:
- The code runs statement parameter binding, time measurement and processing of the results on a single thread.
- With a fast enough server, that one thread will be saturated and we'll see a hard throughput limit again. 

# Going Insanely Multithreaded
We can run multiple streams, each on its own thread. 
To do this, we need `tokio::spawn` again, but this time we'll do it a different level, only once per each thread.

Let's first define a function that can consume a stream in a Tokio task and returns how long it took.
If we use a multitheaded scheduler, it would be likely executed by another thread:

```rust
async fn run_to_completion(mut stream: impl Stream<Item=Duration> + Unpin + Send + 'static) {
    let task = tokio::spawn(async move {
        while let Some(duration) = stream.next().await {}
    });
    task.await;
}
```

Because we're passing the stream to the lambda given to `tokio::spawn`, the stream needs to have `'static` 
lifetime. Unfortunately, this will make it problematic to use with the `make_stream` function we defined earlier:

```rust
let mut stream = make_stream(session, &statement, count);
let elapsed = run_to_completion(stream).await;
```

<pre>
error[E0597]: `session` does not live long enough
   --> src/main.rs:104:34
    |
104 |     let mut stream = make_stream(&session, &statement, count);
    |                      ------------^^^^^^^^--------------------
    |                      |           |
    |                      |           borrowed value does not live long enough
    |                      argument requires that `session` is borrowed for `'static`
...
112 | }
    | - `session` dropped here while still borrowed
</pre>

It looks quite familiar. We've run into this problem already before, when spawning a task for each query.
We have solved that with `Arc`, and now we'll do the same. Notice that this time cloning shouldn't affect
performance, because we do it once per the whole stream:

```rust
async fn run_stream(session: Arc<Session>, statement: Arc<PreparedStatement>, count: usize) {
    let task = tokio::spawn(async move {
        let session = session.as_ref();
        let statement = statement.as_ref();
        let mut stream = make_stream(session, statement, count);
        while let Some(duration) = stream.next().await {}
    });
    task.await;
}
```

Note that we had to move the creation of the `session` and `statement` raw references 
and the creation of the stream to inside of the `spawn` lambda, so they live as long as 
the async task. 

Now we can actually call `run_stream` multiple times and create multiple parallel
statement streams:

```rust
async fn benchmark() {    
    let count = 1000000;

    let session = // ... connect
    let session = Arc::new(session);
    let statement = session.prepare("SELECT * FROM keyspace1.test WHERE pk = ?").unwrap().await.unwrap();
    let statement = Arc::new(statement);

    let benchmark_start = Instant::now();
    let thread_1 = run_stream(session.clone(), statement.clone(), count / 2);
    let thread_2 = run_stream(session.clone(), statement.clone(), count / 2);
    thread_1.await;
    thread_2.await;

    println!(
        "Throughput: {:.1} request/s",
        1000000.0 * count as f64 / benchmark_start.elapsed().as_micros() as f64
    );
```

# Results
Switching my Apache Cassandra Benchmarking Tool [Latte](https://github.com/pkolaczk/latte) to use
this new approach caused the throughput on bigger machines to skyrocket:

<pre>
CONFIG =================================================================================================
            Date        : Mon, 09 Nov 2020                                                         
            Time        : 14:17:36 +0000                                                           
             Tag        :                                                                          
        Workload        : read                                                                     
      Compaction        : STCS                                                                     
      Partitions        :      1000                                                                 
         Columns        :         1                                                                 
     Column size     [B]:        16                                                                 
         Threads        :        24                                                                 
     Connections        :         4                                                                 
 Max parallelism   [req]:       256                                                                 
        Max rate [req/s]:                                                                          
          Warmup   [req]:         1                                                                 
      Iterations   [req]:  10000000                                                                 
        Sampling     [s]:       1.0                                                                 

LOG ====================================================================================================
    Time  Throughput        ----------------------- Response times [ms]---------------------------------
     [s]     [req/s]           Min        25        50        75        90        95        99       Max
   0.000      791822          0.29      6.57      7.01      7.62      9.68     10.90     16.03     67.14
   1.000      830663          1.06      6.68      7.11      7.72      9.25     10.59     12.05     21.57
   2.000      798252          1.49      6.99      7.42      7.93      9.47     11.11     12.35     44.83
   3.000      765633          0.88      6.91      7.34      7.91      9.57     11.24     14.86     72.70
   4.000      797175          1.27      7.00      7.43      7.97      9.57     11.18     12.37     23.04
   5.000      767988          1.35      6.88      7.30      7.85      9.41     11.06     14.46     72.70
   6.000      800712          0.69      6.98      7.40      7.90      9.38     11.06     12.43     22.59
   7.000      800809          1.55      6.98      7.40      7.91      9.25     11.06     12.45     22.88
   8.000      765714          1.54      6.87      7.31      7.90      9.59     11.28     14.51     71.93
   9.000      798496          1.25      6.97      7.42      7.95      9.50     11.13     12.50     25.23
  10.000      763279          1.02      6.88      7.37      7.92      9.60     11.29     15.04     73.28
  11.000      798546          1.10      6.98      7.43      7.95      9.39     11.13     12.43     26.19
  12.000      797906          1.39      6.98      7.43      7.98      9.49     11.19     12.56     37.22

SUMMARY STATS ==========================================================================================
         Elapsed     [s]:    12.656                                                                 
        CPU time     [s]:   294.045          ( 48.4%)                                               
       Completed   [req]:  10000000          (100.0%)                                               
          Errors   [req]:         0          (  0.0%)                                               
      Partitions        :  10000000                                                                 
            Rows        :  10000000                                                                 
         Samples        :        13                                                                 
Mean sample size   [req]:    769231                                                                 
      Throughput [req/s]:    790538 ± 17826                                                         
 Mean resp. time    [ms]:      7.76 ± 0.18                                                          
</pre>

Unfortunately, the server machine was completely saturated at this level.
That's a pity, because the client reported only 48.4% of CPU utilisation and it could probably
go faster with a faster server.

# Takeaways
- Don't assume that if a piece of code is *simple* and *looks fast*, it won't become a bottleneck eventually.
It might not be a bottleneck on the laptop, but may be a problem on a bigger iron or with a different workload.
- I've read somewhere you should spawn plenty of small tasks so the Tokio scheduler can do its
job of balancing work well. This is a good advice, but don't go extreme with that. 
Hundreds thousands of tasks per second is probably a bad idea and would cause CPU time to be spent on scheduling them 
instead of doing real work.
- Rust async streams offer very nice properties related to object lifetimes and code readability. Learn them! Now! :)

