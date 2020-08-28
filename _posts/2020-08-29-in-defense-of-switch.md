---
layout: post
title: In Defense of A Switch 
comments: true
tags: OOP, code-style, polymorphism, software engineering 
excerpt_separator: <!--more-->
---

Recently I came across a [blog post](https://levelup.gitconnected.com/if-else-is-a-poor-mans-polymorphism-ab0b333b7265)
whose author claims, from the perspective of good coding practices, dynamic polymorphism is strictly superior to branching. 
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
You'd probably use something allowing to build a tree:

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
It requires to changle only **one place** – add a new method:

```Scala
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

This solution has also an advantage that the function logic may depend on more than
one object type. For example, the transformation `a * (b + c)` => `a * b + a * c` would depend on 
both addition and multiplication. In the classic OOP solution, would you place it in the `Add` or in the `Mul` class? 
Neither seems right.

# To Sum It Up
Polymorphism scales well when we want to extend the program by adding *types*, but it doesn't scale
well when we want to add *functions* over these types. 
Branching doesn't scale well when we want to extend the program by adding *types*, but it scales well when 
we want to add *functions*. Concluding, neither wins, neither is perfect in all the cases.

# But I Want To Eat My Cake and Have It Too
There are various solutions. One of them is type-classes.
But this is out of scope of this blog post.

# Performance
This is a blog on high performance programming, so the post would be incomplete without a 
paragraph on performance.

 

