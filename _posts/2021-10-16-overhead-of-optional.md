---
layout: post
title: Overhead of Returning Optional Values in Java and Rust
comments: true
tags: performance, optimization, Java, Rust
excerpt_separator: <!--more-->
---

Some programming languages like Java or Scala offer more than one way to express
a concept of "lack of value". Traditionally, a special `null` value is used to denote
references that don't reference any value at all. However, over time we 
have learned that using `null`s can be very error-prone and can cause many troubles like 
`NullPointerException` errors crashing a program in the most unexpected moment. 
Therefore, modern programming style recommends avoiding `nulls` wherever possible 
in favor of a much better `Option`, `Optional` or `Maybe` data type 
(called differently in many languages, but the concept is the same).
Unfortunately, it is believed that optional values in Java may come with a 
performance penalty. In this blog post, I'll try to answer whether 
it is true, and if the performance penalty really exists, how serious it is.

<!--more-->

Before we start, let me point out that if you don't care much about extreme runtime performance, 
you should never use `null` in Java nor Scala, except for in rare cases of working with legacy APIs. 
Just forget `null` ever existed in the language. And if you receive an occasional `null` from an API 
you can't control, just wrap it immediately in `Optional<T>` / `Option[T]`. Don't let `nulls` bite you. 
You won't regret it. To learn the reasons why null pointers / null references are a bad idea,
watch [this talk by Tony Hoare](https://www.infoq.com/presentations/Null-References-The-Billion-Dollar-Mistake-Tony-Hoare/). 

Ok, but if we care about performance? How much do optionals actually cost? 
Some say optionals are expensive because they cause heap allocation and often force the underlying type to be boxed.
Not only heap allocation is costly, but it also forces the garbage collector to run more frequently.
Others say that it doesn't really matter, because the JVM compiler will eliminate the overhead thanks to inlining and escape analysis,
and in most cases it should transform the code to an equivalent of code using null pointers.

Who is right? Let's make a quick benchmark.

# Java Benchmark
How to measure `Optional` overhead? The time to create an `Optional` object instance, even assuming a pessimistic case 
of allocating it on the heap, is likely too small to measure it directly. We need to create many `Optional` objects 
in a tight loop and time the whole loop. 

We also need to make sure the compiler doesn't notice the code does nothing or does
something trivial. We don't want the loop to be eliminated. 
A proper way of dealing with this problem is using all of the `Optional` objects we create so that
their values affect the final result computed in the benchmark. Then the final result must be consumed by a black hole. 
Fortunately a benchmarking tool like [JMH](https://github.com/openjdk/jmh) makes it all easy.

I created three variants of code solving the same task. The task was to compute a sum of all the numbers, skipping the number 
whenever it is equal to a magic constant. The variants differ by the way how skipping is realized:

1. We return primitive `long`s and check if we need to skip by performing a comparison with the magic value directly in the summing loop.
2. We return boxed `Long`s and we return `null` whenever we need to skip a number.
3. We return boxed `Long`s wrapped in `Optional` and we return `Optional.empty()` whenever we need to skip a number.


```java
@State(Scope.Benchmark)
@Fork(1)
@Warmup(iterations = 2)
@Measurement(iterations = 5)
public class OptionBenchmark {

    private final long MAGIC_NUMBER = 7;

    // Variant 1.
    // Probably the simplest way to sum numbers.
    // No boxing, no objects involved, just primitive long values everywhere.
    // This is probably what a C-programmer converted to Java would write ;)
    private long getNumber(long i) {
        return i & 0xFF;
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public long sumSimple() {
        long sum = 0;
        for (long i = 0; i < 1_000_000; ++i) {
            long n = getNumber(i);
            if (n != MAGIC_NUMBER)
                sum += n;
        }
        return sum;
    }

    // Variant 2.
    // Replace MAGIC_NUMBER with a null.
    // To be able to return null, we need to box long into a Long object.
    private Long getNumberOrNull(long i) {
        long n = i & 0xFF;
        return n == MAGIC_NUMBER ? null : n;
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public long sumNulls() {
        long sum = 0;
        for (long i = 0; i < 1_000_000; ++i) {
            Long n = getNumberOrNull(i);
            if (n != null) {
                sum += n;
            }
        }
        return sum;
    }


    // Variant 3.
    // Replace MAGIC_NUMBER with Optional.empty().
    // Now we not only need to box the value into a Long, but also create the Optionsl wrapper.
    private Optional<Long> getOptionalNumber(long i) {
        long n = i & 0xFF;
        return n == MAGIC_NUMBER ? Optional.empty() : Optional.of(n);
    }

    @Benchmark
    @BenchmarkMode(Mode.AverageTime)
    @OutputTimeUnit(TimeUnit.MICROSECONDS)
    public long sumOptional() {
        long sum = 0;
        for (long i = 0; i < 1_000_000; ++i) {
            Optional<Long> n = getOptionalNumber(i);
            if (n.isPresent()) {
                sum += n.get();
            }
        }
        return sum;
    }
}

```

# Results

Obviously all variants compute the same sum, so a *sufficiently smart compiler* should be able to generate exactly the same machine 
code for all of them. The method returning the number is very short and trivial, so I was expecting the compiler to inline it,
remove all of object overhead through escape analysis, unroll and maybe even vectorize the loop.
The number of invocations is constant and known at compile time, and the computations are trivial.
Real code in real projects is usually not as simple as this microbenchmark, so we're essentially testing the best-case scenario here.

OpenJDK 8 (JDK 1.8.0_292, OpenJDK 64-Bit Server VM, 25.292-b10):
<pre>
Benchmark                    Mode  Cnt     Score     Error  Units
OptionBenchmark.sumSimple    avgt    5  1141,557 ± 366,538  us/op
OptionBenchmark.sumNulls     avgt    5  2324,597 ±  79,033  us/op
OptionBenchmark.sumOptional  avgt    5  4576,383 ± 288,571  us/op
</pre>

OpenJDK 11 (Java HotSpot(TM) 64-Bit Server VM, 11+28):
<pre>
Benchmark                    Mode  Cnt     Score     Error  Units
OptionBenchmark.sumSimple    avgt    5   603,683 ±  13,246  us/op
OptionBenchmark.sumNulls     avgt    5  2444,626 ±  35,236  us/op
OptionBenchmark.sumOptional  avgt    5  4303,527 ± 109,900  us/op
</pre>

Graal Community 21.2 (JDK 16.0.2, OpenJDK 64-Bit Server VM, 16.0.2+7-jvmci-21.2-b08): 
<pre>
OptionBenchmark.sumSimple    avgt    5   868,155 ±  42,103  us/op
OptionBenchmark.sumNulls     avgt    5  1937,866 ±  29,938  us/op
OptionBenchmark.sumOptional  avgt    5  4201,451 ± 613,179  us/op
</pre>

OpenJDK 17 (JDK 17-ea, OpenJDK 64-Bit Server VM, 17-ea+19-Ubuntu-1ubuntu1):
<pre>
Benchmark                    Mode  Cnt     Score     Error  Units
OptionBenchmark.sumSimple    avgt    5   449,811 ±  60,889  us/op
OptionBenchmark.sumNulls     avgt    5   952,622 ±  84,138  us/op
OptionBenchmark.sumOptional  avgt    5  4002,787 ± 264,937  us/op
</pre>


Seriously, these outcomes are totally not what I expected. In all cases
JVM did a poor job of eliminating both the boxing and the optionals. 
This led to about 8x worse timings for looping over optionals than looping 
over primitive longs on JDK 17. I even reran the benchmarks 
with explicit `-XX:+DoEscapeAnalysis -XX:+Inline` to make sure these are turned on, 
but that hasn't changed anything (they should be enabled by default anyway).

At least, there is a steady progress in performance between different JDK versions.

## Disabling Inlining
In real production code it can also happen that a method that returns an `Optional` doesn't get inlined.
How does it affect the overhead? I reran the benchmarks with `-XX:-Inline` option:

JDK 1.8.0_292, OpenJDK 64-Bit Server VM, 25.292-b10:
<pre>
Benchmark                    Mode  Cnt      Score      Error  Units
OptionBenchmark.sumSimple    avgt    5   2244,281 ± 1271,115  us/op
OptionBenchmark.sumNulls     avgt    5   9024,197 ±  391,510  us/op
OptionBenchmark.sumOptional  avgt    5  20045,933 ±  777,194  us/op

</pre>

JDK 11, Java HotSpot(TM) 64-Bit Server VM, 11+28
<pre>
Benchmark                    Mode  Cnt      Score      Error  Units
OptionBenchmark.sumSimple    avgt    5   2385,597 ±  323,662  us/op
OptionBenchmark.sumNulls     avgt    5   7900,140 ± 2841,416  us/op
OptionBenchmark.sumOptional  avgt    5  20507,346 ± 5236,451  us/op
</pre>

JDK 17-ea, OpenJDK 64-Bit Server VM, 17-ea+19-Ubuntu-1ubuntu1:
<pre>
Benchmark                    Mode  Cnt      Score      Error  Units
OptionBenchmark.sumSimple    avgt    5   2382,109 ± 1346,017  us/op
OptionBenchmark.sumNulls     avgt    5   7664,463 ± 2040,463  us/op
OptionBenchmark.sumOptional  avgt    5  17961,942 ±  773,224  us/op
</pre>

Everything got much slower, but optionals and boxing overhead are still clearly visible and the ratio
is still more than 7x. The difference between JDKs is much smaller this time. 

# Rust Benchmark

I've rewritten everything to Rust because Rust also has optional values, and I was curious if a similar 
difference would be present. The code was trivial to port, except the variant that was using nulls, because Rust has no nulls 
(which is IMHO a good thing). Instead, I added two more variants:
* A variant with `NonZeroU64` (non zero integer) which should allow the compiler to get rid of the option overhead, 
  and just use value `0` for representing `None`. 
* A special "I would never write Rust like that" variant that returns the value in a `Box` on the heap. This is because a friend
  of mine, after seeing my results, told me I was cheating, because all Rust versions so far used registers/stack to return the value, 
  and Java was at a disadvantage due to returning on the heap (by default). So here you are.

```rust
use std::num::NonZeroU64;

const MAGIC: u64 = 7;

fn get_int(n: u64) -> u64 {
    n & 0xFF
}

pub fn sum_simple() -> u64 {
    let mut sum = 0;
    for i in 0..1_000_000 {
        let n = get_int(i);
        if n != MAGIC {
            sum += n;
        }
    }
    sum
}

fn get_optional_int(n: u64) -> Option<u64> {
    let i = n & 0xFF;
    if i == MAGIC { None } else { Some(i) }
}


pub fn sum_optional() -> u64 {
    let mut sum = 0;
    for i in 0..1_000_000 {
        let value = get_optional_int(i);
        if let Some(k) = value {
            sum += k;
        }
    }
    sum
}

fn get_optional_non_zero(n: u64) -> Option<NonZeroU64> {
    let i = n & 0xFF;
    if i == MAGIC { None } else { NonZeroU64::new(i) }
}

pub fn sum_optional_non_zero() -> u64 {
    let mut sum = 0;
    for i in 0..1_000_000 {
        let value = get_optional_non_zero(i);
        if let Some(k) = value {
            sum += k.get();
        }
    }
    sum
}


fn get_int_boxed(n: u64) -> Box<Option<u64>> {
    let opt = if n == MAGIC { None } else { Some(n) };
    Box::new(opt)
}

pub fn sum_boxed() -> u64 {
    let mut sum = 0;
    for i in 0..1_000_000 {
        let n = get_int_boxed(i);
        if let Some(k) = *n {
            sum += k;
        }
    }
    sum
}

```

## Results
Let the numbers speak for themselves.

With inlining, compiled specifically for my CPU with `RUSTFLAGS="-C target-cpu=native"`:
<pre>
sum_simple              time:   [121.33 us 121.60 us 121.89 us]                        
sum_optional            time:   [121.65 us 121.97 us 122.29 us]                         
sum_optional_non_zero   time:   [123.22 us 123.71 us 124.26 us]                                  
sum_boxed               time:   [122.36 us 123.19 us 124.21 us]    
</pre>


With default release options:
<pre>
sum_simple              time:   [375.58 us 377.02 us 378.73 us]                        
sum_optional            time:   [373.19 us 374.20 us 375.31 us]                         
sum_optional_non_zero   time:   [373.09 us 374.24 us 375.60 us]                                  
sum_boxed               time:   [313.62 us 314.76 us 316.09 us]                      
</pre>

With default release options, but with inlining of the inner functions 
returning the number blocked by `#[inline(never)]`:
<pre>
sum_simple              time:   [1.3899 ms 1.3940 ms 1.3987 ms]                         
sum_optional            time:   [1.4066 ms 1.4117 ms 1.4177 ms]                          
sum_optional_non_zero   time:   [1.1041 ms 1.1089 ms 1.1145 ms]                                   
sum_boxed               time:   [14.882 ms 14.936 ms 14.994 ms]                      
</pre>


# Analysis

Why has Java scored so bad compared to Rust?

I added the `-perfasm` option to the JMH options of the `sumOptional` Java benchmark 
and it resulted in the following disassembly output (I'm actually showing only a relevant fragment of it): 

<pre>
  0,01%   ╭ │     0x00007fcc78d3a3eb:   jmp    0x00007fcc78d3a495           ;*goto {reexecute=0 rethrow=0 return_oop=0}
          │ │                                                               ; - pk.OptionBenchmark::sumOptional@45 (line 73)
  0,31%   │ │  ↗  0x00007fcc78d3a3f0:   mov    QWORD PTR [r15+0x108],rsi
  3,08%   │ │  │  0x00007fcc78d3a3f7:   prefetchw BYTE PTR [rsi+0xc0]
  3,34%   │ │  │  0x00007fcc78d3a3fe:   mov    QWORD PTR [r10],0x1
  0,24%   │ │  │  0x00007fcc78d3a405:   mov    DWORD PTR [r10+0x8],0x49770  ;   {metadata(&apos;java/lang/Long&apos;)}
  0,54%   │ │  │  0x00007fcc78d3a40d:   mov    DWORD PTR [r10+0xc],r12d     ;*new {reexecute=0 rethrow=0 return_oop=0}
          │ │  │                                                            ; - java.lang.Long::valueOf@31 (line 1211)
          │ │  │                                                            ; - pk.OptionBenchmark::getOptionalNumber@21 (line 65)
          │ │  │                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
  2,55%   │ │  │  0x00007fcc78d3a411:   mov    QWORD PTR [r10+0x10],r11
  1,58%   │ │ ↗│  0x00007fcc78d3a415:   mov    rax,QWORD PTR [r15+0x108]
  2,71%   │ │ ││  0x00007fcc78d3a41c:   mov    r11,rax
  0,72%   │ │ ││  0x00007fcc78d3a41f:   add    r11,0x10
  3,48%   │ │ ││  0x00007fcc78d3a423:   cmp    r11,QWORD PTR [r15+0x118]
          │ │ ││  0x00007fcc78d3a42a:   jae    0x00007fcc78d3a574           ;*goto {reexecute=0 rethrow=0 return_oop=0}
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@45 (line 73)
  1,90%   │ │ ││  0x00007fcc78d3a430:   mov    QWORD PTR [r15+0x108],r11
  1,80%   │ │ ││  0x00007fcc78d3a437:   prefetchw BYTE PTR [r11+0xc0]
  5,22%   │ │ ││  0x00007fcc78d3a43f:   mov    QWORD PTR [rax],0x1
  3,78%   │ │ ││  0x00007fcc78d3a446:   mov    DWORD PTR [rax+0x8],0x11af00 ;*new {reexecute=0 rethrow=0 return_oop=0}
          │ │ ││                                                            ; - java.util.Optional::of@0 (line 113)
          │ │ ││                                                            ; - pk.OptionBenchmark::getOptionalNumber@24 (line 65)
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
          │ │ ││                                                            ;   {metadata(&apos;java/util/Optional&apos;)}
  2,20%   │ │ ││  0x00007fcc78d3a44d:   mov    r11,r10
  1,54%   │ │ ││  0x00007fcc78d3a450:   shr    r11,0x3
  0,87%   │ │ ││  0x00007fcc78d3a454:   mov    DWORD PTR [rax+0xc],r11d     ;*synchronization entry
          │ │ ││                                                            ; - pk.OptionBenchmark::getOptionalNumber@-1 (line 64)
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
  3,23%   │ │ ││  0x00007fcc78d3a458:   mov    r11d,DWORD PTR [rax+0xc]     ;*getfield value {reexecute=0 rethrow=0 return_oop=0}
          │ │ ││                                                            ; - java.util.Optional::isPresent@1 (line 154)
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@21 (line 75)
  2,24%   │ │ ││  0x00007fcc78d3a45c:   nop    DWORD PTR [rax+0x0]
  1,47%   │ │ ││  0x00007fcc78d3a460:   test   r11d,r11d
          │╭│ ││  0x00007fcc78d3a463:   je     0x00007fcc78d3a47f
  2,72%   │││ ││  0x00007fcc78d3a465:   mov    r10d,DWORD PTR [r12+r11*8+0x8]
 11,00%   │││ ││  0x00007fcc78d3a46a:   shl    r11,0x3
  0,92%   │││ ││  0x00007fcc78d3a46e:   cmp    r10d,0x49770                 ;*synchronization entry
          │││ ││                                                            ; - pk.OptionBenchmark::getOptionalNumber@-1 (line 64)
          │││ ││                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
          │││ ││                                                            ;   {metadata(&apos;java/lang/Long&apos;)}
          │││ ││  0x00007fcc78d3a475:   jne    0x00007fcc78d3a687           ;*checkcast {reexecute=0 rethrow=0 return_oop=0}
          │││ ││                                                            ; - pk.OptionBenchmark::sumOptional@33 (line 76)
  4,53%   │││ ││  0x00007fcc78d3a47b:   add    rcx,QWORD PTR [r11+0x10]     ;*lload_3 {reexecute=0 rethrow=0 return_oop=0}
          │││ ││                                                            ; - pk.OptionBenchmark::sumOptional@41 (line 73)
  5,89%   │↘│ ││  0x00007fcc78d3a47f:   add    r8,0x1
  0,92%   │ │ ││  0x00007fcc78d3a483:   mov    r11,r8                       ;*synchronization entry
          │ │ ││                                                            ; - pk.OptionBenchmark::getOptionalNumber@-1 (line 64)
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
  0,62%   │ │ ││  0x00007fcc78d3a486:   movzx  r11,r11b                     ;*land {reexecute=0 rethrow=0 return_oop=0}
          │ │ ││                                                            ; - pk.OptionBenchmark::getOptionalNumber@4 (line 64)
          │ │ ││                                                            ; - pk.OptionBenchmark::sumOptional@14 (line 74)
  1,14%   │ │ ││  0x00007fcc78d3a48a:   inc    edi
  4,42%   │ │ ││  0x00007fcc78d3a48c:   cmp    edi,r9d
          │ ╰ ││  0x00007fcc78d3a48f:   jge    0x00007fcc78d3a3b3
</pre>

My knowledge of Intel assembly is quite limited, but I can clearly see a few things:
* The call to `getOptionalNumber` got inlined. There are no calls anywhere in the body of the loop. This is good.
* There is a lot of code caused by allocating and initializing the `Long` instance. 
  We can see `java.lang.Long::valueOf@31 (line 1211)` got inlined, but the allocation hasn't been eliminated. This is very bad.
* There is a similar problem with the `Option` object - it got inlined, but it is still allocated on the heap and 
  its internal structure remained intact. I was hoping for a scalar-replacement here, but weirdly it hasn't happened.
* The number to be summed is being copied out from the `Option` object. There are many needless data transfers between memory and registers.
* Skipping the magic number is performed by a conditional jump. In this case it is probably not a problem, 
  because we're skipping just one number per 256, but this could potentially cause branch misprediction if the ratio was different and not so regular. 
* No SSE/AVX used anywhere. It treated my CPU as if it was some ancient Pentium :(

To confirm my interpretation of the disassembly, I also ran all the benchmarks with `-perf gc`:
<pre>
Benchmark                                                     Mode  Cnt         Score        Error   Units
OptionBenchmark.sumSimple:·gc.alloc.rate                      avgt    5        ≈ 10⁻⁴               MB/sec
OptionBenchmark.sumSimple:·gc.count                           avgt    5           ≈ 0               counts

OptionBenchmark.sumNulls:·gc.alloc.rate                       avgt    5        ≈ 10⁻⁴               MB/sec
OptionBenchmark.sumNulls:·gc.count                            avgt    5           ≈ 0               counts

OptionBenchmark.sumOptional:·gc.alloc.rate                    avgt    5      6193,432 ±    424,465  MB/sec
OptionBenchmark.sumOptional:·gc.count                         avgt    5       546,000               counts
</pre>

As you can see, the `sumOptional` benchmark was allocating at rate over 6 GB/s! 

## Rust output code
The code generated by Rust using default options looks much simpler:

<pre>
            Disassembly of section .text:
               
            0000000000050f40 <benchmark::sum_optional>:
            benchmark::sum_optional:
              mov    $0x4,%ecx
              xor    %edx,%edx
              xor    %eax,%eax
              nop           
  2,67  10:   lea    -0x4(%rcx),%esi
  5,65        lea    -0x3(%rcx),%edi
  2,61        movzbl %sil,%esi
  4,29        cmp    $0x7,%rsi
  2,76        cmove  %rdx,%rsi
  5,71        add    %rax,%rsi
  2,47        lea    -0x2(%rcx),%eax
  4,41        movzbl %dil,%edi
  2,69        cmp    $0x7,%rdi
  6,05        cmove  %rdx,%rdi
  3,29        add    %rsi,%rdi
  3,98        lea    -0x1(%rcx),%esi
  2,53        movzbl %al,%eax
  5,09        cmp    $0x7,%rax
  3,37        cmove  %rdx,%rax
  4,76        add    %rdi,%rax
  2,75        movzbl %sil,%esi
  4,80        cmp    $0x7,%rsi
  3,15        cmove  %rdx,%rsi
  5,64        add    %rax,%rsi
  2,23        movzbl %cl,%eax
  4,18        cmp    $0x7,%rax
  2,78        cmove  %rdx,%rax
  5,31        add    %rsi,%rax
  2,44        add    $0x5,%rcx
              cmp    $0xf4244,%rcx
  4,40      ↑ jne    10     
  0,01      ← ret           
</pre>


The code is much shorter, even despite the fact the loop has been unrolled. It is also way simpler and easier to understand.
In the body of the loop there are no moves between memory and registers, and there are no branches.
Skipping the number is performed with a conditional move instruction which looks like a very natural choice to me.

It is worth noting the code for all of four variants is identical and the compiler even merged copies into one.
The compiler managed to get rid of all the overhead of `Option` and `Box`.
These abstrations turned out to be truly zero-cost!

As a final check I compiled the benchmark with `RUSTFLAGS="-C target-cpu=native"`:

<pre>
             Disassembly of section .text:
               
             0000000000057d50 <benchmark::sum_classic>:
             btree_benchmark::sum_optional:
               sub          $0x38,%rsp
  0,00         vmovdqa      anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x4d0,%ymm0
               vpxor        %xmm11,%xmm11,%xmm11
               mov          $0xf4240,%eax
               vpbroadcastq 0x1d5b31(%rip),%ymm1        # 22d8a0 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x4f0>
               vmovdqu      %ymm1,(%rsp)
               vpbroadcastq 0x1d5b2b(%rip),%ymm2        # 22d8a8 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x4f8>
               vpbroadcastq 0x1d5b2a(%rip),%ymm3        # 22d8b0 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x500>
               vpbroadcastq 0x1d5b29(%rip),%ymm4        # 22d8b8 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x508>
               vpbroadcastq 0x1d5b28(%rip),%ymm5        # 22d8c0 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x510>
               vpbroadcastq 0x1d5b27(%rip),%ymm6        # 22d8c8 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x518>
               vpbroadcastq 0x1d5b26(%rip),%ymm7        # 22d8d0 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x520>
               vpbroadcastq 0x1d5b25(%rip),%ymm8        # 22d8d8 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x528>
               vpbroadcastq 0x1d5b24(%rip),%ymm9        # 22d8e0 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x530>
               vpbroadcastq 0x1d5b23(%rip),%ymm10        # 22d8e8 <anon.b26f45dd7d0ea1d60480ae6c3c88753d.34.llvm.65588711349491208+0x538>
               vpxor        %xmm12,%xmm12,%xmm12
               vpxor        %xmm13,%xmm13,%xmm13
               vpxor        %xmm14,%xmm14,%xmm14
               data16       data16 cs nopw 0x0(%rax,%rax,1)
  1,34   90:   vpand        %ymm4,%ymm0,%ymm15
  3,66         vpcmpeqq     %ymm5,%ymm15,%ymm1
  3,04         vpandn       %ymm15,%ymm1,%ymm1
  0,96         vpaddq       (%rsp),%ymm0,%ymm15
  1,25         vpand        %ymm4,%ymm15,%ymm15
  3,51         vpaddq       %ymm1,%ymm11,%ymm1
  2,94         vpcmpeqq     %ymm5,%ymm15,%ymm11
  2,25         vpandn       %ymm15,%ymm11,%ymm11
  0,80         vpaddq       %ymm2,%ymm0,%ymm15
  3,11         vpand        %ymm4,%ymm15,%ymm15
  3,38         vpaddq       %ymm12,%ymm11,%ymm12
  2,45         vpcmpeqq     %ymm5,%ymm15,%ymm11
  1,73         vpandn       %ymm15,%ymm11,%ymm11
  1,92         vpaddq       %ymm3,%ymm0,%ymm15
  2,93         vpand        %ymm4,%ymm15,%ymm15
  4,20         vpaddq       %ymm13,%ymm11,%ymm13
  1,64         vpcmpeqq     %ymm5,%ymm15,%ymm11
  2,02         vpandn       %ymm15,%ymm11,%ymm11
  4,99         vpaddq       %ymm14,%ymm11,%ymm14
  2,13         vpaddq       %ymm6,%ymm0,%ymm11
  0,66         vpand        %ymm4,%ymm11,%ymm11
  1,97         vpcmpeqq     %ymm5,%ymm11,%ymm15
  4,79         vpandn       %ymm11,%ymm15,%ymm11
  1,72         vpaddq       %ymm7,%ymm0,%ymm15
  0,67         vpand        %ymm4,%ymm15,%ymm15
  2,54         vpaddq       %ymm1,%ymm11,%ymm11
  3,66         vpcmpeqq     %ymm5,%ymm15,%ymm1
  2,39         vpandn       %ymm15,%ymm1,%ymm1
  0,42         vpaddq       %ymm0,%ymm8,%ymm15
  2,02         vpand        %ymm4,%ymm15,%ymm15
  4,75         vpaddq       %ymm1,%ymm12,%ymm12
  2,23         vpcmpeqq     %ymm5,%ymm15,%ymm1
  1,99         vpandn       %ymm15,%ymm1,%ymm1
  1,44         vpaddq       %ymm0,%ymm9,%ymm15
  3,94         vpand        %ymm4,%ymm15,%ymm15
  4,01         vpaddq       %ymm1,%ymm13,%ymm13
  1,84         vpcmpeqq     %ymm5,%ymm15,%ymm1
  1,90         vpandn       %ymm15,%ymm1,%ymm1
  3,97         vpaddq       %ymm1,%ymm14,%ymm14
  1,96         vpaddq       %ymm0,%ymm10,%ymm0
  0,00         add          $0xffffffffffffffe0,%rax
  0,84       ↑ jne          90
  0,00         vpaddq       %ymm11,%ymm12,%ymm0
  0,00         vpaddq       %ymm0,%ymm13,%ymm0
               vpaddq       %ymm0,%ymm14,%ymm0
               vextracti128 $0x1,%ymm0,%xmm1
               vpaddq       %xmm1,%xmm0,%xmm0
               vpshufd      $0xee,%xmm0,%xmm1
  0,00         vpaddq       %xmm1,%xmm0,%xmm0
               vmovq        %xmm0,%rax
               add          $0x38,%rsp
               vzeroupper     
  0,00       ← ret            

</pre>

The loop got nicely vectorised and there are no branches inside the body of the loop either.
It is a bit longer, but it does more per each cycle of the loop and needs fewer cycles. 


# Conclusions
* Using `Optional` values in an extremely performance sensitive Java code is likely a bad idea. All JVMs tested here failed to optimize them out.
* Wrapping primitives in `Optional` caused up to 8x speed degradation and increased allocation rate significantly. Escape analysis optimization failed.
* Avoid boxing numbers and nulls in Java as well. More recent JVMs seem to cope with them better, but none managed to get rid of the overhead totally.
* The most ugly and error-prone solution turned out to be the fastest: primitive types and magic values.
* Don't count on JVM taking advantage of knowing the target CPU and utilizing modern instruction sets like AVX automatically. 
  Actually even the `sumSimple` hasn't been vectorized here, despite being a textbook case for vectorization. 
* Knowing the actual performance profile of the program didn't give JVM any edge here either. 
* Fortunately, the advice above does not apply to Rust. Rust `Option` is zero-cost in most cases and, even without inlining, the added cost is tiny. 
  You don't have to trade code readability nor safety to gain speed.
* Rust code returning `Option` optimized for my CPU was over **30x** faster than Java code returning `Optional`, 
  and still over **10x** faster if compiled in a portable way with default settings and no vectorization. 
* Quite surprisingly, even the pessimized version of Rust code forced to allocate the `Option` on heap with no inlining was still faster than JVM doing the same. 
  Is manual heap allocation not really slower than GC-based allocation? Probably a topic for another blog post.
* Languages and their compilers vastly differ in optimization strength. Don't assume all languages that can compile to machine code are the same. 


Disclaimer: Do measure performance by yourself and don't assume particular optimizations will / won't take place because you saw someone mentioning them in the blog post.
YMMV.
