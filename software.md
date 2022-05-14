---
layout: page
title: Software
comments: false
---

## [Fclones](https://github.com/pkolaczk/fclones) – A super fast duplicate file finder

`fclones` is a command-line duplicate file finder and remover I've written in Rust.

I started this project as an exercise in Rust programming, but it quickly turned into
a feature-rich program that competes with well known programs like `fdupes`. 

Selected features:

* Searching for duplicate files in multiple directory trees
* Plenty of file filtering and selection options
* Safety with two-stage operation: find duplicates first, remove only after inspecting they are good to go
* Multiple ways of getting rid of duplicates: removing, moving, linking, reflinking
* Probably best-in-class performance: can handle terabytes of data and millions of files with ease
* Composability with other tools: piping, json input / output

`fclones` works best on Linux but runs also on macOS and Windows.

---

## [Latte](https://github.com/pkolaczk/latte) – A Cassandra benchmarking tool

Latte runs custom CQL workloads against a Cassandra cluster and measures throughput and response times.

I created this tool because I was not happy with the performance of other benchmarking tools written in Java, 
which were often more CPU and memory hungry than a Cassandra server instance. 

Latte was written in Rust and is so lightweight that I can run it on the same computer as Cassandra instance
and it doesn't cause visible overhead. Latte also scales very well on big multi-core, multi-socket machines and can 
run over a million requests per second from a single machine. 

Selected features:

* Benchmarking Cassandra or Scylla clusters
* Support for authentication and SSL
* Custom workload generation with embedded scripting engine
* Insensitivity to coordinated omission
* Detailed statistics
* Saving and comparing results of multiple runs

