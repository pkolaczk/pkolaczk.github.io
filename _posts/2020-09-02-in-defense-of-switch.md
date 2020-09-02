---
layout: post
title: In Defense of a Switch 
comments: true
tags: OOP, code-style, polymorphism, dynamic dispatch, pattern matching, Rust, Scala 
excerpt_separator: <!--more-->
---

Recently I came across a [blog post](https://levelup.gitconnected.com/if-else-is-a-poor-mans-polymorphism-ab0b333b7265)
whose author claims, from the perspective of good coding practices, polymorphism is strictly superior to branching. 
In the post they make general statements about how branching statements lead to unreadable, unmaintainable, inflexible code and
how they are a sign of immaturity. However, in my opinion, the topic is much deeper and in this post 
I try to objectively discuss the reasons for and against branching.

<!--more-->

# Is My Code Easy to Extend?

Before I dive into polymorphism vs branching dilemma, let's first define what we mean when we say some code is
flexible and easy to extend. In my career I reviewed thousands of lines of code, and I had thousands of lines of my code
reviewed by others, and during these reviews it often occured that the terms *code extensibility* or *flexibility* 
mean different things to different people. Familiarity with the code-base or particular programming style plays a huge role.

For example, someone used to writing code in a Java/C# OOP style would generally consider dynamic polymorphism through 
interfaces a standard way of providing extensibility to the code, 
while a C programmer may find a switch or if/else much more 
approachable than OOP. There are also many other factors related 
to maintainability as quality of documentation, good naming, separation of concerns, etc. These factors are orthogonal 
to the "polymorphism vs branching" dimension and also far too broad for a single blog post, so I won't discuss them. 

For the sake of this post, let's define *extensibility* as the inverse of number of distinct units in the codebase
that need to be changed in order to implement a new feature. The more places you have to touch to implement the feature, 
the harder the code is to change. Obviously, it is much better when you have to touch only
one unit of code (one function, one class, one module, one package) rather than change 10 distinct unrelated units. 

# Example
Imagine you're writing a calculator. Your program gets an expression as an input and outputs the computed value.
For example the user inputs `1 + 2 * 3` and the output is `7` 
(or `9` if you've messed up the operator precedence like one of my former CS students). 

Why such a silly example? Who is writing calculators these days? Probably no-one, but this looks like a classic example given
in many programming classes. And it is easy enough to illustrate the concept. 

How can we model a structure to represent an expression?
You'd probably use classes or structures. Here is the code in Scala:

```scala
trait Expression {
    def eval: Double
}

case class Const(value: Double) extends Expression {
    def eval: Double = value
}

case class Add(left: Expression, right: Expression) extends Expression {
    def eval: Double = left.eval + right.eval
}
``` 

Then it is quite easy to build an expression and evaluate it:
```scala
Add(Const(2), Const(3)).eval // evaluates to 5 
```

# Adding New Classes
This OOP-based solution is indeed very extensible when it comes to add a new operator.
The example above is missing subtraction operation. We can add one by defining a new class:

```scala
case class Sub(left: Expression, right: Expression) extends Expression {
    def eval: Double = left.eval - right.eval
}
```

That's really awesome – we didn't have to touch any old code at all! 
OOP definitely rocks here. 

# Adding New Operations
Imagine you continued to extend our calculation engine with more operation classes over the next few years.
You've added multiplication, division, modulo, variables, logarithms, trigonometric functions, etc.

Then suddenly a new requirement comes – users want to not only evaluate the value of an expression,
but also do symbolic manipulation – e.g. simplify expressions. For example, given an expression
`a + a` they want to get an expression `2 * a` as a result. 

This requirement can't be captured by the `eval` method on the `Expression` interface. We need a new method:

```scala
trait Expression {
    def eval: Double
    def simplify: Expression
}
```
 
And as the next step, they would likely want to be able to display the expression as a String:

```scala
trait Expression {
    def eval: Double
    def simplify: Expression
    def toString: String
}
```

How many units of code do you have to change now to implement these features?
**All the implementations of `Expression`**. Before touching all the classes, the code wouldn't even compile.
It looks like in the context of this kind of feature, our polymorphic solution is terribly non-extensible. 

# What Can Switch Do About It?
Let's take a step back and let's see how we could implement this differently.
Scala and many other modern languages have a feature called *pattern matching*
which can be considered a very flexible, powerful switch.

Instead of defining the operations like `eval` or `simplify` on the case classes,
let's pull them up:

```scala
trait Expression {
case class Const(value: Double) extends Expression
case class Add(left: Expression, right: Expression) extends Expression


def eval(e: Expression): Double = {
  e match {
    case Const(x) => x
    case Add(a, b) => a + b
  }
}
``` 
 
Now adding a new operation like `Sub` would require two changes to the code – adding a new class
*and* adding a new case in the match (switch) statement. 

Some may say this much worse not only because of more places to update, but because of a possibility of
forgetting to update the switches which could lead to runtime errors due to unhandled cases.
Fortunately, Scala designers thought about this by providing the `sealed` keyword, which instructs the compiler
that all case classes can be defined in the same module only. This unlocks pattern exhaustiveness analysis and the
compiler would warn about missing cases:


```scala
sealed trait Expression
case class Const(value: Double) extends Expression
case class Add(left: Expression, right: Expression) extends Expression

def eval(e: Expression): Double = {
  e match {
    case Const(x) => x
    case Add(a, b) => a + b
  }
}
``` 

What about adding new functions like `simplify` or `toString`? 
It requires to changle only **one place** – by adding the required methods. 
No changes to the existing code are needed!

```scala
def simplify(e: Expression): Expression = {
  e match {
    case Add(Const(0), x) => x
    case Add(x, Const(0)) => x
    case other => other
  }
}

def toString(e: Expression): String = {
  e match {
    case Const(x) => x.toString
    case Add(a, b) => "(" + toString(a) + " + " + toString(b) + ") 
  }
}
``` 

# Code Readability
The blog post I mentioned in the introduction stated that using polymorphism instead of
branching leads to more readable code. I find this statement far too general and actually very debatable. 

First, even in their own example given by the author of that blog, the solution using branching was a lot
shorter and less complex than the solution using OOP. While brief code is not always more readable than a longer version of it,
in that case, I found branching to be very explicit and easy to follow. 
It is much easier to understand the control flow
in such a program because all targets are explicitly given in a single place. In the OOP solution, 
the actual implementations are hidden behind the interface and it is much harder to find them all without additional 
help of a good IDE with a "jump to implementations" feature 
(which fortunately often works well for statically typed languages, but I've seen IDEs sometimes 
struggle with dynamic languages like Python). 

Second, in general case, branching has an advantage that the function logic may depend on more than
one object type or even the actual data. For example, in the example from this post, 
the transformation `a * (b + c)` => `a * b + a * c` would depend on 
both addition and multiplication. In the classic OOP solution, would you place it in the `Add` or in the `Mul` class? 
Neither seems right. Also, putting it into one of them creates a dependency on the other one. 
An expression simplifier with code scattered accross multiple classes heavily depending on each other 
would be hard to understand.

# Performance
This is a blog on high performance programming, so the post would be incomplete without a 
section on performance. In theory, a sufficiently good compiler should produce the same
code regardless of the choice between branching or dynamic polymorphism, but is this the case in reality?
Compilers have limitations and often don't generate the best result code possible.

Let's consider a more realistic example this time.
Some time ago I was working on serializing/deserializing code in a database system.
I stumbled upon a set of classes that described data types. They all implemented 
a common interface defining methods for serializing and deserializing values of given data type
and also computing serialized data lenghts. The following Rust snippet is a huge simplification 
of that code, but it illustrates the concept:

```rust
pub trait DataType {
    fn len(&self) -> usize;
}

pub struct BoolType;
pub struct IntType;
pub struct LongType;

impl DataType for BoolType {
    fn len(&self) -> usize { 1 }
}

impl DataType for IntType {
    fn len(&self) -> usize { 4 }
}

impl DataType for LongType {
    fn len(&self) -> usize { 8 }
}

pub fn data_len(data_type: &dyn DataType) -> usize {
    data_type.len()
}
```

Given a reference to a `DataType` object, it is trivial to compute the data size associated with it, 
without knowing the exact static type:

```rust
let t1 = IntType;
let t2 = LongType;
let v: Vec<&dyn DataType> = vec![&t1, &t2];
println!("{}", data_len(v[0]));  // prints 4
println!("{}", data_len(v[1]));  // prints 8
```

## Performance of Dynamic Dispatch

The implementation of the `data_len` function is actually very simple:
```nasm
jmpq *0x18(%rsi)
```

Wow! A single assembly instruction! 
It jumps to the address stored in the the vtable of the object pointed by the `rsi` register.
The target of the jump depends on the actual type of the object. Here is the code generated for `IntType.len`:

```nasm
mov  $0x4,%eax
retq
```

The codes for the other types differ only in the constant value. 

These are only 3 instructions to return the result. Shouldn't it be fast? 
Let's measure this. Let's put more random `DataType` objects into a vector, 
iterate them and print out the sum of the values returned by `data_len()` to avoid any attempts 
at dead code elimination by the compiler:

```rust
let mut rng = rand::thread_rng();
let mut data = Vec::<Box<dyn DataType>>::new();
for i in 1..1000000 {
    match rng.gen_range(0, 3) {
        0 => data.push(Box::new(BoolType)),
        1 => data.push(Box::new(IntType)),
        _ => data.push(Box::new(LongType)),        
    }
}

let mut len = 0;
for i in 0..1000 {
    for dt in data.iter() {
        len += data_len(dt.as_ref());
    }
}
println!("Total len: {}", len);
```

A `perf stat` on this program yields:
<pre>
      6 777,73 msec task-clock                #    1,000 CPUs utilized          
            13      context-switches          #    0,002 K/sec                  
             1      cpu-migrations            #    0,000 K/sec                  
         4 047      page-faults               #    0,597 K/sec                  
23 800 190 663      cycles                    #    3,512 GHz                    
10 076 137 503      instructions              #    0,42  insn per cycle         
 4 012 788 756      branches                  #    592,055 M/sec                  
   667 673 937      branch-misses             #    16,64% of all branches        
     4 556 657      LLC-loads-misses     

   6,778608106 seconds time elapsed
</pre>

One thing that immediately stands out is a high number of branch misses and low instructions-per-cycle.
Even though the code is short, an indirect jump to a random location can't be predicted in many cases,
therefore the CPU pipeline stalls for a while and many cycles go to waste.

Another issue with runtime polymorphism is that it requires using heap for storing the objects.
We can't store objects of different types directly in a vector, because their sizes might potentially 
differ. The size of each item in the vector must be the same. Therefore, we can only store 
references (pointers) in the vector and the objects data must be allocated elsewhere. 
Traversing these references causes random memory accesses (which is called often *pointer chasing*) 
which reduces the efficiency of CPU caches and may cause a lot of cache misses for large enough data structures. 
In this case `perf` recorded over 4 million of last-level-cache misses.

## Performance of a Match / Switch 

We can implement the same logic using enums and a match:
```rust
pub enum DataType {
    BoolType,
    IntType,
    LongType
}

pub fn data_len(data_type: &DataType) -> usize {
    match data_type {
        DataType::BoolType => 1,
        DataType::IntType => 4,
        DataType::LongType => 8
    }
}
```

This allows to put the `DataType` objects inside of a vector directly, because now they are all the same size and have the same static type:

```rust
let mut data = Vec::<DataType>::new();
let mut rng = rand::thread_rng();
for i in 1..1000000 {
    match rng.gen_range(0, 3) {
        0 => data.push(DataType::BoolType),
        1 => data.push(DataType::IntType),
        2 => data.push(DataType::LongType),
        _ => {}
    }
}

let mut len = 0;
for i in 0..1000 {
    for dt in data.iter() {
        len += data_len(dt);
    }
}
println!("Total len: {}", len);
```

Let's look at the code generated for `data_len`:
```nasm
movzbl (%rdi),%eax
lea    anon.d7e157471cbbc210d945c8fcb95e1baa.3.llvm.2081724968588745877+0xc,%rcx
mov    (%rcx,%rax,8),%rax
retq
```

There is no branching in this code! The compiler noticed a simple lookup table does 
the job. So not only the vector is now totally flat and there is no pointer chasing, 
but also there are no jumps. The effect on performance is significant:

<pre>
      1 762,37 msec task-clock                #    1,000 CPUs utilized          
             8      context-switches          #    0,005 K/sec                  
             0      cpu-migrations            #    0,000 K/sec                  
           387      page-faults               #    0,220 K/sec                  
 6 361 343 641      cycles                    #    3,610 GHz                    
10 053 423 994      instructions              #    1,58  insn per cycle         
 3 009 768 006      branches                  #    1707,796 M/sec                  
     1 127 367      branch-misses             #    0,04% of all branches        
        33 221      LLC-loads-misses 

   1,762797864 seconds time elapsed
</pre>

That's almost 4 times faster! 
The numbers of branch misses and LLC misses are at least two orders of magnitude lower.

Of course, you may find more complex cases where branching would yield exactly same performance
as a virtual table dispatch, because often a switch / match is implemented by a jump-table as well.
However, generally, branching offers the compiler more flexibility to optimize because all the jump
targets are known in advance. In case of virtual dispatch, a static compiler may not know all the jump 
targets at the time of compilation so generally such code is harder to optimize. 

# Conclusions

- Polymorphism scales well when we want to extend the program by adding *types*, but it doesn't scale
well when we want to add *functions* over these types. 
- Branching scales well when we want to extend the program by adding *functions* but it doesn't scale well when we want to add *types*. 
- Branching is a cleaner solution when the dispatch target depends on more than a single type. 
- Branching gives the compiler much more room to optimize.

# Further Reading
[Expression Problem](https://en.wikipedia.org/wiki/Expression_problem)
