---
layout: post
title: Multiple Thread Pools in Rust
comments: true
tags: performance concurrency Rust borrow-checker unsafe Rayon 
excerpt_separator: <!--more-->
---

In [the previous post]({% post_url 2020-08-24-disk-parallelism %}), I showed how processing 
file data in parallel can either boost or hurt performance 
depending on the workload and device capabilities. Therefore, in complex programs that mix tasks
of different types using different physical resources, e.g. CPU, storage (e.g. HDD/SSD) 
or network I/O, a need may arise to configure parallelism levels differently for each task type. 
This is typically solved by scheduling tasks of different types on dedicated thread pools.
In this post I'm showing how to implement a solution in Rust with [Rayon](https://crates.io/crates/rayon). 
<!--more-->

After I realized multi-threaded access to data on a single HDD is a *really bad idea*, 
I wanted to process files residing on HDD with only one thread-per-device, but still keep multithreading for SSDs.
Also, both groups of files should be processed independently, in parallel.
Honestly, that didn't look like something hard to do. I've been using thread pools in Java for years.
For each file to process, I just need to schedule an asynchronous hashing task on a proper thread pool 
executor and that's it. How hard could that be in Rust?

My program already used Rayon in a very functional style, so the main part of the code responsible for file hashing 
looked like that:

```rust
let files: Vec<std::path::PathBuf> = ...   // collection of input files
let hashes: Vec<FileHash> = files
  .into_par_iter()           // creates a Rayon parallel iterator over all files
  .map(|f| compute_hash(f))  // reads the contents of a file and returns its hash; blocking
  .collect();                
```
In this approach, all the files are processed by the default Rayon thread pool and
there is no place to tell Rayon which thread pool to use for given file.

# A Single Custom Thread Pool

Rayon allows to build custom thread pools with `ThreadPoolBuilder` and `ThreadPool` structs. 
It is quite easy to create a custom thread pool and manually spawn tasks on it:

```rust
use std::thread;
let pool = rayon::ThreadPoolBuilder::new()
    .num_threads(4)
    .build()
    .unwrap();
pool.spawn(|| println!("Task executes on thread: {:?}", thread::current().id()));
pool.spawn(|| println!("Task executes on thread: {:?}", thread::current().id()));
```

In order to process our collection on this custom thread pool, we need to change the "main loop" of 
a program slightly and replace the parallel iterator with a traditional loop and a channel to receive the 
results:

```rust
let pool = rayon::ThreadPoolBuilder::new()
    .num_threads(4)
    .build()
    .unwrap();
let files: Vec<std::path::PathBuf> = ...
let (tx, rx) = std::sync::mpsc::channel();
for f in files.into_iter() {
    let tx = tx.clone();  
    pool.spawn(move || { 
        tx.send(compute_hash(f)).unwrap(); 
    });
}
drop(tx); // need to close all senders, otherwise...
let hashes: Vec<FileHash> = rx.into_iter().collect();  // ... this would block
```

# Multiple Thread Pools
Now it is quite straightforward to transform this approach to more than one thread pool:

```rust
let hdd_pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
let ssd_pool = rayon::ThreadPoolBuilder::new().num_threads(16).build().unwrap(); 

let files: Vec<std::path::PathBuf> = ...
let (tx, rx) = std::sync::mpsc::channel();
for f in files.into_iter() {
    let tx = tx.clone();  
    let pool = if is_on_ssd(&f) { 
        &ssd_pool 
    } else { 
        &hdd_pool 
    };
    pool.spawn(move || { 
        tx.send(compute_hash(f)).unwrap(); 
    });
}
drop(tx); 
let hashes: Vec<FileHash> = rx.into_iter().collect(); 
```

The implementation of `is_on_ssd` is left as an exercise for the reader ;)

# Scopes
Unfortunately `ThreadPool.spawn()` method requires that the lambda passed to it has a 
`'static` lifetime, which means it must not borrow any data other than global. 
The examples above work only because we pass all the input data by `move`, so the lambda
does not close over anything outside and the `'static` constraint is satisfied.

Of course the real world is much more complex, and, in my program actually the spawned task  
needed to borrow the local context, which holds some common stuff like configuration or logger. 

Referencing any outside variable from inside of `spawn` lambda does not compile:
```rust
let logger: Log = Log::new();
let logger = &logger;
for f in files.into_iter() {
    let tx = tx.clone();
    pool.spawn(move || {
        logger.println(format!("Computing hash of: {}", f.display()));
        tx.send(compute_hash(f)).unwrap();
    });
}
```

<pre>
error[E0597]: `logger` does not live long enough
  --> src/pools.rs:13:18
   |
13 |       let logger = &logger;
   |                    ^^^^^^^ borrowed value does not live long enough
...
16 | /         pool.spawn(move || {
17 | |             logger.println(format!("Computing hash of: {}", f.display()));
18 | |             tx.send(f).unwrap();
19 | |         });
   | |__________- argument requires that `logger` is borrowed for `'static`
...
22 |   }
   |   - `logger` dropped here while still borrowed

</pre>

The compiler can't see that all the tasks we spawned must finish before we leave the scope
where `logger` is valid. This is where Rayon scopes are coming to rescue us. 

Instead of spawning tasks directly on the thread pool struct, we first need to create a scope 
object by calling `scope` function. The scope is guaranteed to exit only after all tasks launched 
inside it finished. This essentially allows the tasks inside the scope to access variables that live 
at least as long as the scope:

```rust
let (tx, rx) = std::sync::mpsc::channel();
let logger: &Log = ...;
pool.scope(move |s| {
    for f in files.into_iter() {
        let tx = tx.clone();
        s.spawn(move |s| {
            logger.println(format!("Computing hash of: {}", f.display()));  // ok
            tx.send(f).unwrap();
        });
    }
});
```

What about multiple thread pools? 
A single `Scope` in Rayon is always associated with a single `ThreadPool`. 
Therefore, if we need multiple thread pools, then we need multiple scopes, active at the same time.
Fortunately, scopes can be nested:

```rust
let (tx, rx) = std::sync::mpsc::channel();
let logger: &Log = ...;
hdd_pool.scope(move |hdd_scope| {
    ssd_pool.scope(move |ssd_scope| {
        for f in files.into_iter() {
            let tx = tx.clone();
            if is_on_ssd(&f) {
              ssd_scope.spawn(move |s| { ... });          
            } else { 
              hdd_scope.spawn(move |s| { ... });
            }
        }
    });
});
```

## Dynamic Number of Thread Pools
With only two pools, nesting doesn't look bad, but in my program I needed more than two pools – 
one per each physical device. And even worse, I didn't know the number of them statically at compile time.

At this point I wanted to abstract out the process of creating nested scopes in a way it doesn't pollute the 
logic of the program. I came up with the following function idea:


```rust
pub fn multi_scope<'scope, OP, R>(pools: &[&ThreadPool], op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send
```

This takes an array of `ThreadPool` references, constructs a `Scope` for each `ThreadPool` 
and executes a user-defined operation (typically passed as a lambda) inside all of these scopes.
The operation receives a list of references to `Scope` so it can spawn tasks on desired `Scope` associated
with the given `ThreadPool`. The usage is quite straightforward and very similar to the built-in `scope`:

```rust
use rayon::ThreadPoolBuilder;

let hdd_pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
let ssd_pool = rayon::ThreadPoolBuilder::new().num_threads(16).build().unwrap(); 
let pools = [&hdd_pool, &ssd_pool]; // this could be constructed dynamically in real-world code

let common = vec![0, 1, 2]; // common data
multi_scope(&pools, |scopes| {
    scopes[0].spawn(|s| { /* execute on hdd_pool, can use &common */ });
    scopes[1].spawn(|s| { /* execute on ssd_pool, can use &common */ });
});
```

How to implement `multi_scope`? There is no way to obtain a `Scope` value directly from Rayon.
The only way we can get a reference to a `Scope` is inside the lambda passed to `scope`.
So if we need multiple scopes active at the same time, we must nest scopes in each other. 
This sounds like a recursion. 

## My Code Is Correct, But The Borrow Checker Disagrees
My initial take looked like this:

```rust
pub fn multi_scope<'scope, OP, R>(pools: &[&ThreadPool], op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    nest(pools, Vec::with_capacity(pools.len()), op)
}

fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = scopes;
            scopes.push(s);
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

An additional function `nest` creates one new `Scope` and pushes it into the `scopes` vector, then it calls itself
recursively until it runs out of `ThreadPool` values. Finally it calls the user operation `op` 
passing the created `scopes` vector to it. 

To my surprise that didn't compile. Oh well!
<pre>
error[E0621]: explicit lifetime required in the type of `scopes`
  --> src/pools.rs:42:25
   |
34 | fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&Scope<'scope>>, op: OP) -> R
   |                                                       ------------------- help: add explicit lifetime `'scope` to the type of `scopes`: `std::vec::Vec<&'scope rayon_core::scope::Scope<'scope>>`
...
42 |             scopes.push(s);
   |                         ^ lifetime `'scope` required

</pre>

Wait, there is a hint here. As usual with Rust coding, let's apply the hint the compiler gave to us:

```rust
fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&'scope Scope<'scope>>, op: OP) -> R
```

But this made it only worse:
<pre>
error[E0495]: cannot infer an appropriate lifetime due to conflicting requirements
  --> src/pools.rs:41:33
   |
41 |             let mut scopes: Vec<&Scope<'scope>> = scopes;
   |                                 ^
   |
note: first, the lifetime cannot outlive the anonymous lifetime #2 defined on the body at 40:24...
  --> src/pools.rs:40:24
   |
40 |           pools[0].scope(move |s| {
   |  ________________________^
41 | |             let mut scopes: Vec<&Scope<'scope>> = scopes;
42 | |             scopes.push(s);
43 | |             nest(&pools[1..], scopes, op)
44 | |         })
   | |_________^
note: ...so that reference does not outlive borrowed content
  --> src/pools.rs:42:25
   |
42 |             scopes.push(s);
   |                         ^
note: but, the lifetime must be valid for the lifetime `'scope` as defined on the function body at 34:9...
  --> src/pools.rs:34:9
   |
34 | fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&'scope Scope<'scope>>, op: OP) -> R
   |         ^^^^^^
note: ...so that the expression is assignable
  --> src/pools.rs:43:31
   |
43 |             nest(&pools[1..], scopes, op)
   |                               ^^^^^^
   = note: expected `std::vec::Vec<&rayon_core::scope::Scope<'_>>`
              found `std::vec::Vec<&rayon_core::scope::Scope<'scope>>`
</pre>

What happens if we try to "help" the compiler with inferring the `scopes` vector lifetime and require all references to be valid for at least `'scope`?
```rust
fn nest<'scope, OP, R>(pools: &'scope [&'scope ThreadPool], scopes: Vec<&'scope Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes: Vec<&'scope Scope<'scope>> = scopes;
            scopes.push(s);
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }

```
<pre>
error[E0312]: lifetime of reference outlives lifetime of borrowed content...
  --> src/pools.rs:42:25
   |
42 |             scopes.push(s);
   |                         ^
   |
note: ...the reference is valid for the lifetime `'scope` as defined on the function body at 34:9...
  --> src/pools.rs:34:9
   |
34 | fn nest<'scope, OP, R>(pools: &'scope [&'scope ThreadPool], scopes: Vec<&'scope Scope<'scope>>, op: OP) -> R
   |         ^^^^^^
note: ...but the borrowed content is only valid for the anonymous lifetime #2 defined on the body at 40:24
  --> src/pools.rs:40:24
   |
40 |           pools[0].scope(move |s| {
   |  ________________________^
41 | |             let mut scopes: Vec<&'scope Scope<'scope>> = scopes;
42 | |             scopes.push(s);
43 | |             nest(&pools[1..], scopes, op)
44 | |         })
   | |_________^
</pre>

Looks like we can't really add the new scope to the vector, because now the vector type requires 
that the references stored in it live for the time of the outermost scope. Rust collections obviously cannot hold
references to data that lives shorter than the collection itself, therefore `'scope` must not be shorter than
the lifetime of the vector created at the outermost recursion level.

## The Borrow Checker Doesn't Give Up Easily

Another idea I tried was to decouple the lifetime of the references inside the vector from the actual `'scope` by introducing
a new lifetime `'vec`, hoping that the vector would narrow down the lifetime of the innermost scope inserted into it 
(which should be ok because we will lend the vector only to the innermost scope at the end):

```rust
fn nest<'scope, 'vec, OP, R>(pools: &[&ThreadPool], scopes: Vec<&'vec Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes: Vec<&Scope<'scope>> = scopes;
            scopes.push(s);
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

Almost worked, but still one more error to go...
<pre>
error[E0623]: lifetime mismatch
  --> src/pools.rs:42:25
   |
34 | fn nest<'scope, 'vec, OP, R>(pools: &[&ThreadPool], scopes: Vec<&'vec Scope<'scope>>, op: OP) -> R
   |                                                                 -------------------
   |                                                                 |
   |                                                                 these two types are declared with different lifetimes...
...
42 |             scopes.push(s);
   |                         ^ ...but data from `scopes` flows into `scopes` here
</pre>

This time the error message is not helpful at all. Why is the compiler saying "these two types" while pointing to a single type?
This baffled me for a while, but eventually I realized this must have something to do with `'vec` being inferred differently 
for the next recursion level than `'vec` on the current level. And what does it mean "`scopes` flows into `scopes`"?

## Blocked By Invariance

I started experimenting a bit by removing some code and I realized these two logically incorrect versions compile just fine:

```rust
fn nest<'scope, 'vec, OP, R>(pools: &'scope[&'scope ThreadPool], scopes: Vec<&'vec Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = Vec::new();    // <--- look here
            scopes.push(s);                 // <--- look here
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

```rust
fn nest<'scope, 'vec, OP, R>(pools: &'scope[&'scope ThreadPool], scopes: Vec<&'vec Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = scopes;        // <--- look here
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

So I can either add the newly created scope to my vector as the only item, or I can pass the existing vector as is without inserting the new scope!
But I can't do both! This problem typically happens when you try to add values of different incompatible types to a collection, but here I'm adding 
values of the same type, so I should be fine...

Unfortunately, Rayon's `Scope` struct is *invariant* over its lifetime parameter, and the lifetime is obviously a part of the type. 
In this case the compiler won't coerce one scope to another, e.g. by shortening the lifetime of the outer scope to match the lifetime of the inner scope,
nor by extending the lifetime of the inner scope to match the outer scope. 
This means we can't put references to two scopes into a single vector, at least not without changing the 
source code of Rayon or changing how the type system works in Rust. What a bummer! 

## Going Unsafe

Fortunately, the tiny difference in scope lifetimes caused by nesting is all internal to the `nest` function and is never observable by 
the client's code. From the outside, we can safely assume all scopes were created with the same lifetime – 
they are all created by `nest` and all dropped by it together.  

This is the moment where Rust's `unsafe` comes to the rescue. 
We can "cheat" a bit, and let the compiler adjust our scope lifetimes so they match and can be stored in a single vector:

```rust
unsafe fn adjust_lifetime<'s, 'a, 'b>(scope: &'s Scope<'a>) -> &'s Scope<'b> {
    std::mem::transmute::<&'s Scope<'a>, &'s Scope<'b>>(scope)
}

fn nest<'scope, 'vec, OP, R>(pools: &'scope[&'scope ThreadPool], scopes: Vec<&'vec Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = scopes;
            scopes.push(unsafe { adjust_lifetime(s) });
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

Actually some lifetime annotations can be dropped and the compiler is still happy:
```rust
unsafe fn adjust_lifetime<'s, 'a, 'b>(scope: &'s Scope<'a>) -> &'s Scope<'b> {
    std::mem::transmute::<&'s Scope<'a>, &'s Scope<'b>>(scope)
}

fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&Scope<'scope>>, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s [&'s Scope<'scope>]) -> R + 'scope + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = scopes;
            scopes.push(unsafe { adjust_lifetime(s) });
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}
```

## Update: Getting Rid of Unsafe 
Fortunately Rayon 1.4.0 changed its `scope` signature a bit and now it is possible to completely avoid `unsafe`.

Rayon 1.3.0 defines `scope` function as follows:

```rust
/// Creates a scope that executes within this thread-pool.
/// Equivalent to `self.install(|| scope(...))`.
///
/// See also: [the `scope()` function][scope].
///
/// [scope]: fn.scope.html
pub fn scope<'scope, OP, R>(&self, op: OP) -> R
where
    OP: for<'s> FnOnce(&'s Scope<'scope>) -> R + 'scope + Send,
    R: Send,
{
    self.install(|| scope(op))
}
```

There is an explicit requirement that the passed `op` lambda lives for at least as
long as `'scope` therefore `'scope` can never be inferred to be wider than the lifetime of `op`.

In Rayon 1.4.0 `scope` has been changed into:

```rust
/// Creates a scope that executes within this thread-pool.
/// Equivalent to `self.install(|| scope(...))`.
///
/// See also: [the `scope()` function][scope].
///
/// [scope]: fn.scope.html
pub fn scope<'scope, OP, R>(&self, op: OP) -> R
where
    OP: FnOnce(&Scope<'scope>) -> R + Send,
    R: Send,
{
    self.install(|| scope(op))
}
```

Now the `'scope` is allowed to be a wider lifetime than the lifetime of a lambda.
If we nest scopes, they all can get the same `'scope` that can hold the outermost 
lambda. Therefore it is enough to remove the `+ 'scope` requirement in our code and drop the
`adjust_lifetime` call:

```rust
use rayon::{Scope, ThreadPool};

fn nest<'scope, OP, R>(pools: &[&ThreadPool], scopes: Vec<&Scope<'scope>>, op: OP) -> R
where
    OP: FnOnce(&[&Scope<'scope>]) -> R + Send,
    R: Send,
{
    if !pools.is_empty() {
        pools[0].scope(move |s| {
            let mut scopes = scopes;
            scopes.push(s);
            nest(&pools[1..], scopes, op)
        })
    } else {
        (op)(&scopes)
    }
}

/// Creates multiple Rayon scopes, one per given `ThreadPool`, around the given lambda `op`.
/// The purpose of this method is to be able to spawn tasks on multiple thread pools when
/// the number of thread pools is not known at compile-time. Same as with a single scope,
/// all tasks spawned by `op` are guaranteed to finish before this call exits, so they
/// are allowed to access structs from outside of the scope.
///
/// # Example
/// ```
/// use rayon::ThreadPoolBuilder;
/// use fclones::pools::multi_scope;
///
/// let pool1 = ThreadPoolBuilder::new().build().unwrap();
/// let pool2 = ThreadPoolBuilder::new().build().unwrap();
/// let common = vec![0, 1, 2]; // common data, must be Send
/// multi_scope(&[&pool1, &pool2], |scopes| {
///     scopes[0].spawn(|_| { /* execute on pool1, can use &common */ });
///     scopes[1].spawn(|_| { /* execute on pool2, can use &common */ });
/// });
/// ```
pub fn multi_scope<'scope, OP, R>(pools: &[&ThreadPool], op: OP) -> R
where
    OP: FnOnce(&[&Scope<'scope>]) -> R + Send,
    R: Send,
{
    nest(pools, Vec::with_capacity(pools.len()), op)
}
```
