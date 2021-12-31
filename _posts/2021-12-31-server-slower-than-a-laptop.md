---
layout: post
title: How a Single Line of Code Made a 24-core Server Slower Than a Laptop
comments: true
tags: performance, memory management, scalability, Rust
excerpt_separator: <!--more-->
---

<script type="text/javascript" src="/assets/graphs/graphs.js"></script>

Imagine you wrote a program for a pleasingly parallel problem,
where each thread does its own independent piece of work, 
and the threads don't need to coordinate except joining the results at the end. 
Obviously you'd expect the more cores it runs on, the faster it is. 
You benchmark it on a laptop first and indeed you find out it scales 
nearly perfectly on all of the 4 available cores. Then you run it on a big, fancy, multiprocessor
machine, expecting even better performance, only to see it actually runs slower  
than the laptop, no matter how many cores you give it. Uh. That has just happened to me recently.

<!--more-->
I've been working recently on a Cassandra benchmarking tool [Latte](https://github.com/pkolaczk/latte) 
which is probably the most efficient Cassandra benchmarking tool you can get, both in terms of CPU use and memory use.
The whole idea is very simple: a small piece of code generates data and executes a bunch of 
asynchronous CQL statements against Cassandra. 
Latte calls that code in a loop and records how long each iteration took. 
Finally, it makes a statistical analysis and displays it in various forms. 

Benchmarking seems to be a very pleasant problem to parallelize. 
As long as the code under benchmark is stateless, it can be fairly trivially called
from multiple threads. I've blogged about how to achieve that in Rust 
already [here]({% post_url 2020-10-05-benchmarking-cassandra %}) and 
[here]({% post_url 2020-11-30-benchmarking-cassandra-with-rust-streams %}).

However, at the time I wrote those earlier blog posts, Latte's workload definition capabilities were ~~nonexistent~~ quite limited.
It came with only two predefined, hardcoded workloads, one for reading and another one for writing. 
There were a few things you could parameterize, e.g. the number or the sizes of table columns, but nothing really fancy.
No secondary indexes. No custom filtering clauses. No control over the CQL text. Really nothing. 
So, overall, Latte at that time was more of a proof-of-concept rather than a universal tool for doing real work.
Surely, you could fork it and write a new workload in Rust, then compile everything from source. But who wants to waste time 
on learning *the internals* of a niche benchmarking tool? 

## Rune scripting
So the last year, in order to be able to measure the performance of storage attached indexes in Cassandra, 
I decided to integrate Latte with a scripting engine that would allow me to easily define workloads without recompiling
the whole program. After playing a bit with embedding CQL statements in TOML config files (which turned out to be both messy and limited at the same time), 
through having some fun with embedding Lua (which is probably great in C world, but didn't play so nice with Rust as I expected, although it kinda worked), 
I eventually ended up with a design similar to that of [sysbench](https://github.com/akopytov/sysbench) but 
with an embedded [Rune](https://rune-rs.github.io/) interpreter instead of Lua. 

The main selling points of Rune that convinced me were painless Rust integration and support for async code. 
Thanks to async support, the user can execute CQL statements directly in the workload scripts, leveraging the asynchronous nature
of the Cassandra driver. Additionally, the Rune team is amazingly helpful and removed anything that blocked me in virtually no time. 

Here is an example of a complete workload that measures performance of selecting rows by random keys:

```rust
const ROW_COUNT = latte::param!("rows", 100000);

const KEYSPACE = "latte";
const TABLE = "basic";

pub async fn schema(ctx) {
    ctx.execute(`CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} \
                    WITH REPLICATION = { 'class' : 'SimpleStrategy', 'replication_factor' : 1 }`).await?;
    ctx.execute(`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.${TABLE}(id bigint PRIMARY KEY)`).await?;
}

pub async fn erase(ctx) {
    ctx.execute(`TRUNCATE TABLE ${KEYSPACE}.${TABLE}`).await?;
}

pub async fn prepare(ctx) {
    ctx.load_cycle_count = ROW_COUNT;
    ctx.prepare("insert", `INSERT INTO ${KEYSPACE}.${TABLE}(id) VALUES (:id)`).await?;
    ctx.prepare("select", `SELECT * FROM ${KEYSPACE}.${TABLE} WHERE id = :id`).await?;
}

pub async fn load(ctx, i) {
    ctx.execute_prepared("insert", [i]).await?;
}

pub async fn run(ctx, i) {
    ctx.execute_prepared("select", [latte::hash(i) % ROW_COUNT]).await?;
}
```

You can find more info on how to write those scripts in the [README](https://github.com/pkolaczk/latte/#readme).

## Benchmarking the benchmarking program
Although the scripts are not JIT-compiled to native code yet, they are acceptably fast, and thanks to the limited amount of code they 
typically contain, they don't show up at the top of the profile. I've empirically found that the overhead of Rust-Rune FFI was lower than that of 
Rust-Lua provided by [mlua](https://crates.io/crates/mlua/), probably due to the safety checks employed by mlua. 

Initially, to assess the performance of the benchmarking loop, I created an empty script:

```rust
pub async fn run(ctx, i) {
}
```

Even though there is no function body there, the benchmarking program needs to do some work to actually run it:
- schedule N parallel asynchronous invocations using [`buffer_unordered`](https://docs.rs/futures/0.3.19/futures/stream/trait.StreamExt.html#method.buffer_unordered) 
- setup a fresh local state (e.g. stack) for the Rune VM
- invoke the Rune function, passing the parameters from the Rust side
- measure the time it took to complete each returned future
- collect logs, update HDR histograms and compute other statistics
- and run all of that on M threads using Tokio threaded scheduler

The results on my old 4-core laptop with Intel Xeon E3-1505M v6 locked at 3 GHz looked very promising:

<div class="figure">
    <div style="height:20em"><canvas id="orig-perf-laptop"></canvas></div>
    <script>
    makeBarChartDeferred("orig-perf-laptop", "throughput [Mop/s]", "threads",
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        {"throughput": [1.596817, 3.313762, 4.623016, 6.540220, 6.560180, 7.319449, 7.672276, 7.988835, 8.023773, 7.982255, 7.978040, 7.980927]});
    </script>    
</div>


Because there are 4 cores, the throughput increases linearly up to 4 threads. Then it increases slightly more 
up to 8 threads, thanks to hyper-threading that squeezes a bit more performance out of each core. Obviously there is no
performance improvement beyond 8 threads, because all CPU resources are saturated at this point.

I was also satisfied with the absolute numbers I got. A few million of empty calls per second on a laptop sounds like
the benchmarking loop is lightweight enough to not cause significant overhead in real measurements. A local Cassandra server
launched on the same laptop can only do about 200k requests per second when fully loaded and that only if those requests are 
stupidly simple and all the data fits in memory. 

By the way, after adding some real code for data generation in the body, but with no calls to the database, as expected 
everything got proportionally slower, but not more than 2x slower, so it was still in a "millions ops per second" range. 

That was easy. I could have stopped here and announce victory. However, I was curious how fast it could go if tried on a bigger machine with more cores.

## Running an empty loop on 24 cores
A server with two Intel Xeon CPU E5-2650L v3 processors, each with 12 cores running at 1.8 GHz should be obviously a lot faster than an old 4-core laptop, shouldn't it?
Well, maybe with 1 thread it would be slower because of lower CPU frequency (3 GHz vs 1.8 GHz), but it should make up for that by having many more cores. 

Let the numbers speak for themselves:

<div class="figure">
    <div style="height:28em"><canvas id="orig-perf-server"></canvas></div>
    <script>
    makeBarChartDeferred("orig-perf-server", "throughput [Mop/s]", "threads",
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 24, 36, 48, 96],
        {"throughput": [1.325938, 1.915190, 1.963769, 1.751019, 1.611263, 1.495254, 1.452816, 1.519251, 1.420541, 1.463928, 1.342367, 1.330432, 1.416689, 1.518840, 1.672394, 1.964795, 2.011382]});
    </script>    
</div>

You'll agree there is something wrong here. Two threads are better than one... and that's basically it. 
I couldn't squeeze more throughput than about 2 million calls per second, 
which was about 4x worse than the throughput I got on the laptop. 
Either the server was a lemon or my program had a serious scalability issue.

## Investigation
When you hit a performance problem, the most common way of investigating it is to run the code under profiler.
In Rust, it is very easy to generate flamegraphs with `cargo flamegraph`. 
Let's compare the flamegraphs collected when running the benchmark with 1 thread vs 12 threads:

![flamegraph 1 thread](/assets/img/server-slower-than-a-laptop/flamegraph-t1.svg){:class="img-responsive"}

![flamegraph 12 threads](/assets/img/server-slower-than-a-laptop/flamegraph-t12.svg){:class="img-responsive"}

I was expecting to find a single thing that was a bottleneck, e.g. a contended mutex or something similar, but to my surprise, there was nothing obvious there.
There wasn't even a single bottleneck! Rune's `VM::run` code seemed to take about 1/3 of the time, but the rest was simply taken
by polling futures and quite likely the culprit got inlined and disappeared from the profile.

Anyway, because of `VM::run` and the path `rune::shared::assert_send::AssertSend` leading also to Rune, I decided to disable the code responsible for
calling the Rune function, and I reran the experiment with just a loop running an empty future, albeit with timing and statistics code still enabled:

```rust
// Executes a single iteration of a workload.
// This should be idempotent –
// the generated action should be a function of the iteration number.
// Returns the end time of the query.
pub async fn run(&self, iteration: i64) -> Result<Instant, LatteError> {
    let start_time = Instant::now();
    let session = SessionRef::new(&self.session);
    // let result = self
    //     .program
    //     .async_call(self.function, (session, iteration))
    //     .await
    //     .map(|_| ()); // erase Value, because Value is !Send
    let end_time = Instant::now();
    let mut state = self.state.try_lock().unwrap();
    state.fn_stats.operation_completed(end_time - start_time);
    // ... 
    Ok(end_time)   
}
```

That scaled fine to over 100M calls per second on 48 threads! 
So the problem must be somewhere below the `Program::async_call` function:

```rust
// Compiled workload program
pub struct Program {
    sources: Sources,
    context: Arc<RuntimeContext>, 
    unit: Arc<Unit>,
}

// Executes given async function with args.
// If execution fails, emits diagnostic messages, e.g. stacktrace to standard error stream.
// Also signals an error if the function execution succeeds, but the function returns
// an error value.    
pub async fn async_call(
    &self,
    fun: FnRef,
    args: impl Args + Send,
) -> Result<Value, LatteError> {
    let handle_err = |e: VmError| {
        let mut out = StandardStream::stderr(ColorChoice::Auto);
        let _ = e.emit(&mut out, &self.sources);
        LatteError::ScriptExecError(fun.name, e)
    };
    let execution = self.vm().send_execute(fun.hash, args).map_err(handle_err)?;
    let result = execution.async_complete().await.map_err(handle_err)?;
    self.convert_error(fun.name, result)
}

// Initializes a fresh virtual machine needed to execute this program.
// This is extremely lightweight.
fn vm(&self) -> Vm {
    Vm::new(self.context.clone(), self.unit.clone())
}

```

The `async_call` function does a few things: 
- it prepares a fresh Rune VM – this is supposed to be a very lightweight operation that basically prepares a fresh stack; the VMs are *not* shared between calls nor threads so they can run totally independently
- it invokes a function by passing its identifier and parameters
- finally it receives the result and converts some errors; we can safely assume that in an empty benchmark this is a no-op

My next idea was to just remove the `send_execute` and `async_complete` calls and leave just the VM preparation.
So basically I wanted to benchmark that line:

```rust
Vm::new(self.context.clone(), self.unit.clone())
```

The code looks fairly innocent. No locks, no mutexes, no syscalls, no shared mutable data here. 
There are some read-only structures `context` and `unit` shared behind an `Arc`, but read-only sharing
shouldn't be a problem.

`VM::new` is also trivial:

```rust
impl Vm {

    // Construct a new virtual machine.
    pub const fn new(context: Arc<RuntimeContext>, unit: Arc<Unit>) -> Self {
        Self::with_stack(context, unit, Stack::new())
    }

    // Construct a new virtual machine with a custom stack.
    pub const fn with_stack(context: Arc<RuntimeContext>, unit: Arc<Unit>, stack: Stack) -> Self {
        Self {
            context,
            unit,
            ip: 0,
            stack,
            call_frames: vec::Vec::new(),
        }
    }
```

However, not matter how innocent the code looks, I like to double check my assumptions. 
I ran that with different numbers of threads and, although it was now faster than before, 
*it didn't scale at all again* – it hit a throughput ceiling of about 4 million calls per second!  

## The problem

Although at first it doesn't look like there is any sharing of mutable *data* in the code above, actually 
there is something slightly hidden that's shared and mutated: the `Arc` reference counters themselves. 
Those counters are shared between all the invocations, performed from many threads, and 
they are the source of the congestion here.

Some may argue that atomically increasing or decreasing a shared atomic counter shouldn't be a problem because those
are "lockless" operations. They even translate to single assembly instructions (e.g. `lock xadd`)! If something is a single assembly
instruction, it is not slow, isn't it? That reasoning is unfortunately flawed. 

The root of the problem is not really the computation, but the cost of maintaining the shared state.

The amount of time required to read or write data is mostly influenced by how far the CPU core needs to reach out for the data.
Here are the typical latencies for the Intel Haswell Xeon CPUs according to [this site](https://www.7-cpu.com/cpu/Haswell.html):
- L1 cache: 4 cycles
- L2 cache: 12 cycles
- L3 cache: 43 cycles
- RAM: 62 cycles + 100 ns

L1 and L2 caches are typically local to a core (L2 may be shared by two cores). L3 cache is shared by all cores of a CPU.
There is also a direct interconnect between L3 caches of different processors on the main board for managing L3 cache coherency, so L3 is 
logically shared between all *processors*.

As long as you don't update the cache line and only read it from multiple threads, the line will be loaded by multiple cores 
and marked as shared. It is likely that frequent accesses to such data would be served from L1 cache, which is very fast. Therefore sharing 
read-only data is perfectly fine and scales well. Even using atomics for only reading will be plenty fast in that case.

However, once we introduce updates to the shared cache line, things start to complicate. The x86-amd64 architecture has coherent data caches.
This means basically that what you write on one core, you can read back on another one. It is not possible to store a cache line with conflicting data 
in multiple cores. Once a thread decides to update a shared cache line, that line gets invalidated on all the other cores, so subsequent loads
on those cores would have to fetch the data from at least L3. That is obviously a lot slower, and even slower if there 
are more processors than one on the main board. 

The fact that our reference counters are atomic is an additional problem that makes things even more complex for the processor. 
Although using atomic instructions is often referred to as "lockless programming", this is slightly misleading – 
in fact, atomic operations require some locking to happen at the hardware level. This locking is very fine-grained and cheap as long as there is no congestion,
but as usual with locking, you may expect very poor performance if many things try to fight for the same lock at the same time. And it is of course
much worse if those "things" are whole CPUs and not just single cores that are close to each other. 

## The fix
The obvious fix is to avoid *sharing* the reference counters. Latte has a very simple, hierarchical lifecycle structure, 
so all those `Arc` updates looked like an overkill to me and they could probably be replaced with simpler references and Rust lifetimes. 
However, this is easier said than done. Unfortunately Rune requires the references to the `Unit` and `RuntimeContext`
to be passed wrapped in `Arc` for managing the lifetime (in probably more complex scenarios) and it also uses some `Arc`-wrapped values internally as part of those
structures. Rewriting Rune just for my tiny use case was out of the question.

Therefore the `Arc` had to stay. Instead of using a single `Arc` value we can use one `Arc` per thread. 
That requires also separating the `Unit` and `RuntimeContext` values, so each thread would get their own. 
As a side effect, this guarantees there is no sharing at all, so even if Rune clones an `Arc` stored internally as a part of those values, that problem would be also fixed.
The downside of this solution is higher memory use. Fortunately . Latte workload scripts are usually tiny, so higher memory use is likely not a big problem. 

To be able to use separate `Unit` and `RuntimeContext` I submitted [a patch](https://github.com/rune-rs/rune/pull/371) to Rune to make them `Clone`.
Then, on the Latte side, the whole fix was actually introducing a new function for "deep" cloning the `Program` struct and then making sure
each thread gets its own copy:

```rust
    // Makes a deep copy of context and unit.
    // Calling this method instead of `clone` ensures that Rune runtime structures
    // are separate and can be moved to different CPU cores efficiently without accidental
    // sharing of Arc references.
    fn unshare(&self) -> Program {
        Program {
            sources: self.sources.clone(),
            context: Arc::new(self.context.as_ref().clone()),   // clones the value under Arc and wraps it in a new counter
            unit: Arc::new(self.unit.as_ref().clone()),         // clones the value under Arc and wraps it in a new counter
        }
    }
```
BTW: The `sources` field is not used during the execution, except for emitting diagnostics, so it could be left shared. 

Note that the original line where I originally found the slowdown did not need any changes!

```rust
Vm::new(self.context.clone(), self.unit.clone())
```

This is because `self.context` and `self.unit` are not shared between threads anymore.
Atomic updates to non-shared counters are fortunately very fast.

## Final results

Now the throughput scales linearly up to 24 threads, as expected:

<div class="figure">
    <div style="height:40em"><canvas id="patched-perf-server"></canvas></div>
    <script>
    makeBarChartDeferred("patched-perf-server", "throughput [Mop/s]", "threads",
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 36, 48, 96],
        {"throughput": [1.354843, 2.650137, 3.765986, 4.990307, 6.019777, 7.064436, 8.145090, 8.867020, 10.375281, 11.558317, 12.549360, 13.905626, 14.931279, 16.042679, 17.136669, 18.417760, 
                        19.532883,  20.500464, 21.868790, 22.875926, 24.004263, 25.079142, 26.133108, 27.373602, 29.786954, 30.908860, 30.656631]});
    </script>    
</div>


## Takeaways
* The cost of a shared `Arc` might be absurdly high on some hardware configurations if it is updated frequently on many threads.
* Don't assume that a single assembly instruction cannot become a performance problem.
* Don't assume that if something scales fine on a single-CPU computer, it would still scale on a multi-CPU computer.

