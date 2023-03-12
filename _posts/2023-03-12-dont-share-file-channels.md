---
layout: post
title: Don't Share Java FileChannels
comments: true
tags: performance safety threads concurrency Java channel
excerpt_separator: <!--more-->
---

A user opens an issue complaining the server-side
application you developed for them frequently crashes with "too many open files" error
under heavy load. What do you do?
Admin: "Just tell them to raise their file descriptor limits".
Software developer: "No, no, hold my beer, I can fix it in the app".

<!--more-->

A few minutes later, the developer dives into the code of their Java server.
Very quickly they notice the application creates multiple `FileChannel`
instances whenever a new request comes. Indeed, a session
recorded with Java flight recorder confirms that under heavy load the number
of opened `FileChannel` instances is crazy high, and the number of created
file descriptors goes through the roof.

The first guess "maybe we're not closing them sometimes and there's a leak..."
turns out to be wrong this time, because the number of descriptors
drops back to the baseline when the load finishes.

Then they inspect which files are opened and it appears that actually only a dozen of
files is responsible for all those descriptors.

> – Ok, that's easy then. Let's open each `FileChannel` only once per file. If multiple things
  want to use them, then just share.
>
> – But, isn't it dangerous? Are they thread safe? What about file position?
>
> – Indeed, some methods are not safe. We'll write a facade that exposes only the safe methods.

Java's `FileChannel` maintains an internal file position and offers methods
that access or update that file position explicitly or implicitly.
Obviously, those methods are not thread-safe, because this file position is shared.

- `position()`
- `position(long newPosition)`
- `read(ByteBuffer dst)`
- `read(ByteBuffer[] dsts)`
- `read(ByteBuffer[] dsts, int offset, int length)`
- `write(ByteBuffer src)`
- `write(ByteBuffer[] srcs)`
- `write(ByteBuffer[] srcs, int offset, int length)`

However, there also exists a bunch of methods that take an explicit file position and promise
to never update the shared one. They look quite ok, don't they?

- `read(ByteBuffer dst, long position)`
- `write(ByteBuffer src, long position)`

Hence, the developer creates a `FileChannel` facade exposing only the safe methods,
and writes a few multi-threaded unit tests to confirm the methods work correctly and no
data races happen. Everything seems to be working fine. And of course, the problem of
too many file descriptors is gone now. The code gets through end-to-end testing
and is finally released to the users. Users are happy and don't complain on "too many open files" any more. The issue gets closed in the bug tracker as fixed. Total success!

However, in the following months, some new reports start appearing.
Users report that app services sometimes fail randomly with `ChannelClosedException`.
The problem happens very rarely, and despite many attempts,
no-one can reproduce it for months. Initially developers suspect a
use-after-close bug, but careful manual analysis of the code doesn't reveal any problems.
The exceptions gets thrown always when a `FileChannel` operation is attempted, e.g. read or write,
as if another thread closed the shared channel without waiting for all the other users.
However, the reference counting code that makes sure a shared `FileChannel` is closed after the last
use also looks good. Logging confirms the app does *not* close the channel at all before the
`ChannelClosedException` happens.

Eventually someone notices this tiny snippet of the `FileChannel`'s docs:

<pre>
public abstract int read(ByteBuffer dst, long position) throws IOException

...

Throws:
    ClosedChannelException - If this channel is closed
    ClosedByInterruptException - If another thread interrupts the current
        thread while the read operation is in progress, thereby closing the
        channel and setting the current thread's interrupt status

</pre>

I bet many developers don't read those "Throws" sections very carefully always (including me).
If an I/O operation fails, they catch the exception somewhere, maybe a few layers up,
log it or tell the user in other way that something bad happened.
I also bet that whenever they see `IOException` in the signature
they assume the cause is *external* to the application. E.g. a user placed a file in a wrong place. Or a disk failed. Or a client abruptly terminated a network connection. What we often don't realize
is that an `IOException` can be caused by the app itself, on demand.

If you read the docs carefully, you'll notice words "interrupts" and "thereby closing the channel". Interrupts are a Java mechanism that allows to unblock a thread stuck in an I/O operation.
Of course interrupts can be used for many other things, but if a thread that's blocked in an I/O
operation receives an interrupt, the blocking call will immediately exit with `ClosedByInterruptException`. The exception is not the only side-effect.
Another side-effect is closing the channel. Eh wait, what?! Closing the channel?

Yes! If a channel is shared and one of the threads using it receives an interrupt while being
in a read or a write call, the channel gets closed. And if it gets closed, all the other threads
that use it will also see it closed, and their I/O operations will start failing. That was the
cause of unexpected `ClosedChannelException`s.

## Conclusion

The JavaDoc for `FileChannel` nowhere mentioned the API was thread-safe. Even if some methods
look like they can have safe happy path, the way they handle errors or interrupts may cause issues.

Lessons learned (again and again):
* Code against the documentation, don't assume extra properties of the API.
* Read the section about error handling just as carefully as the main description. Sometimes
  the way how exceptional situations are handled might be surprising.
* If something is unlikely but possible, it will eventually happen in production.
* Testing is a poor way of protecting against data races.















