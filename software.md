---
layout: page
title: Software
comments: false
---

## [Fclones](https://github.com/pkolaczk/fclones) – A super fast duplicate file finder

`Fclones` is a command-line duplicate file finder and remover I've written in Rust.

I started this project as an exercise in Rust programming, but it quickly turned into
a feature-rich program that competes with well known programs like `fdupes`.

Selected features:

* Searching for duplicate files in multiple directory trees
* Plenty of file filtering and selection options
* Safety with two-stage operation: find duplicates first, remove only after inspecting they are good to go
* Multiple ways of getting rid of duplicates: removing, moving, linking, reflinking
* Probably best-in-class performance: can handle terabytes of data and millions of files with ease
* Composability with other tools: piping, json input / output

`Fclones` works best on Linux but runs also on macOS and Windows.

---

## [Fclones GUI](https://github.com/pkolaczk/fclones-gui) – An super fast interactive duplicate file finder

`Fclones-gui` is a simple graphical frontend for `fclones`. Thanks to GTK4, it uses native graphical controls of Gnome and looks very nice on my Ubuntu. It also works on several other Linux distros and macOS. It is considerably easier to use than the CLI cousin, and equally fast, because it shares the same file deduplication engine.


![screenshot](/assets/img/fclones/input.png)
![screenshot](/assets/img/fclones/duplicates.png)

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

