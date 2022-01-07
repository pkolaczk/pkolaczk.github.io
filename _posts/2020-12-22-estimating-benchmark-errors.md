---
layout: post
title: Estimating Benchmark Results Uncertainty
comments: true
tags: benchmarking, statistics, mean, standard error, autocovariance, autocorrelation
mathjax: true
excerpt_separator: <!--more-->
---

Physicists say that a measurement result given without an error estimate is worthless. This applies
to benchmarking as well. We not only want to know how performant a computer program or a system is, 
but we also want to know if we can trust the performance numbers. This article explains how to compute
uncertainty intervals and how to avoid some traps caused by applying commonly known
statistical methods without validating their assumptions first. 

<!--more-->

In my previous posts I focused on building a tool that can measure performance of a database system.
That simple tool gave a single value as its output. If you ran it multiple times, you'd notice, that even
when measuring the performance of the same server again and again, the results are slightly different 
each time. 

# Sources of Variance
There are several sources of variance of performance:

- Unstable hardware performance. Many computers allow dynamic CPU frequency scaling, so their speed of processing
is not constant. The frequency can be changed in response to load or temperature change. When benchmarking
you should beware of these effects, because they can introduce a lot of variance into the results. It is recommended
to lock CPU frequency to a constant value low enough that it can be maintained for the whole measurement time, 
without the risk of thermal-throttling. Storage is also another source of big variance. You typically have
no control over where the operating system decides to store data on a spinning drive.

- Complexity of the software layers running the benchmarked program. For example JVM based programs manage memory
by GC, which kicks in at random points in time. Even modern concurrent GCs impose some performance
penalty when running, despite not causing a full freeze (pause) of the process threads. 
There is also a lot of noise introduced by code compilation when the JVM is not yet warmed up. This applies likely to other
managed runtimes as well.

- Sharing the same hardware between multiple applications or services. If the service you're benchmarking shares
resources with other apps, then activity of those other apps will affect the results of your measurement. 
If possible, try to lock exclusive access to physical devices critical to the performance of 
the program you're measuring. 

- External or internal asynchronous signals that need to be handled, e.g. network traffic, device interrupts, etc.
Even if the benchmark program doesn't use network or any peripheral devices, the system needs to spend a tiny 
amount of computing power to handle them – and that power might be taken from the benchmarked app. 

- Caching effects. You may notice that an disk I/O heavy benchmark may run faster the second time you run it,
if you don't evict the page cache before each run. Some caches may be easy to reset, but some may be inaccessible.

- Finally the benchmarked program itself might not have truly deterministic performance profile. For example a database
system might want to run periodic tasks to cleanup dead data, etc. 

There are probably many other reasons that I missed. While it is worth spending some time on minimizing 
the biggest sources of noise, it may be uneconomical or even outright impossible to get rid of all of the
noise. Therefore your results will always have some degree of variance. 

# Basic Statistics
Because the measured value behaves randomly, it can be modelled by a random variable. 
For further reference, let's call it $$X$$.
We can characterize the performance of the system by the statistical distribution
of $$X$$. Of course, we never know the true distribution, but we can get some estimate
of it by measuring (observing) the value $$N$$ times and applying some exciting maths to them to get a few useful numbers.

Programmers very frequently compute basic satictics such as:
- Arithmetic mean – estimates of the *expected value* of $$X$$
- Standard deviation – estimates how much values sampled from $$X$$ are dispersed around the mean and is useful to judge the stability of the performance. 
  This doesn't depend on the number of observations $$N$$, because this is a property of $$X$$. If you're getting a high standard deviation of the results, 
  you may want to look at eliminating some of the sources of noise mentioned in the earlier section.
- Standard error of the mean – estimates how far the mean we estimated from the sample could be from the true expected value of $$X$$. Typically
  we should expect this gets smaller the more measurements (more information about the underlying distribution) we have.
- Percentiles / Histogram – can be used to visualize the distribution and is particularly useful when the distribution is not normal, e.g. in cases
  like response-time distribution. High percentiles like 99.9% can give a lot of useful information about hiccups in the system caused by e.g. GC, etc.

# Standard Error of the Mean
The standard error $$s_{\bar{X}}$$ of the mean is a useful metric that describes how accurately 
we estimated the expected value. We can estimate it from the data by using the following formulas:

$$ \hat{s} = \sqrt{ \frac{1}{N - 1} \sum_{i = 1}^{N} (x_i - \bar{x})^2 } $$ 

$$ \hat{s}_{\bar{X}} = \frac{\hat{s}}{\sqrt{N}} $$

where $$ \bar{x} $$ denotes the mean of the observations and $$s$$ denotes the standard deviation from the mean. 
You don't have to remember that formula nor code it manually, because probably every statistical library in most programming languages 
offers it out-of-the-box. 

Why is the standard error such a useful metric? If we average a large enough number of observations, 
by [the Central Limit Theorem](https://en.wikipedia.org/wiki/Central_limit_theorem), 
the sample average $$ \bar{X} $$ will be distributed very closely to the normal distribution $$ \mathcal{N}(\mu, \sigma^2) $$ where
$$ \mu \approx \bar{x} $$ and $$ \sigma \approx \hat{s}_{\bar{X}}$$. The really good news is that typically $$N = 10$$ is already 
"large enough" and also the distribution of $$X$$ doesn't need to be normal – it is enough it has finite mean and variance. 
BTW: If your benchmark results have infinite variance, then you may have a bigger problem than calculating the error of the mean.

This conclusion allows us to obtain confidence intervals for $$ \bar{x} $$:

| lower bound                        |                upper bound          |  probability $$ \mathrm{E}X $$ lies within the bounds |
|------------------------------------|-------------------------------------|-------------------------------------------------------|
| $$\bar{x} - \hat{s}_{\bar{X}} $$   | $$\bar{x} + \hat{s}_{\bar{X}} $$    |  0.6827
| $$\bar{x} - 2 \hat{s}_{\bar{X}} $$ | $$\bar{x} + 2 \hat{s}_{\bar{X}} $$  |  0.9545
| $$\bar{x} - 3 \hat{s}_{\bar{X}} $$ | $$\bar{x} + 3 \hat{s}_{\bar{X}} $$  |  0.9973

The normal distributuion probability function is another nice thing that's available in most statistical libraries, so
you could compute custom confidence intervals for any probability you wish easily.

# There is a Trap
Computing has this nice property that, unlike in biology, geography, medical or social sciences, it makes it easy and cheap to 
obtain huge samples. Every quadrupling of the sample size makes the confidence interval twice narrower for the same probability,
because there is $$\sqrt{N}$$ in the denominator of the formula for the standard error, and the enumerator depends only on the distribution
of $$X$$, but not the number of observations. So, theoretically, we could estimate the expected value with any 
accuracy we wish, and we're only limited by the time we're allowed to run the test. 

Let's take for example, that we want to compute the average response time of the server. 
We issue $$N$$ requests and calculate their mean. The local single node Casssandra server installed
on my development laptop can easily handle ~180k requests per second. Whoa! This makes my $$N = 180000$$ for a benchmark that takes only a single second.
I can easily collect 1 million data points in less than 10 seconds. 1 million data points 
should make the error of the average response time estimate very small. 

Indeed, with 99.9% confidence interval and $$N = 1$$ million, I obtained a result like this:

<pre>
Avg response time: 2.45 ± 0.01 ms
</pre>

What a lovely tiny error!
If it takes only a few seconds, why not run it a few more times to make really sure the result is correct?

<pre>
Avg response time: 2.51 ± 0.01 ms
Avg response time: 2.48 ± 0.01 ms
Avg response time: 2.57 ± 0.01 ms
Avg response time: 2.42 ± 0.01 ms
Avg response time: 2.47 ± 0.01 ms
</pre>

Wait... did I say **99.9%** confidence interval? 
Why are my numbers fluctuating so much?! The differences definitely exceed the error interval. 

After double checking the implementation and running more tests to verify I'm not just getting those ugly results by an extreme unlikely bad luck, 
I found that...

# Assumptions Matter
There is a nice joke about biologists and statisticians going to a conference by train.

> 3 biologists and 3 statisticians were going to a scientific conference in the same car compartment.
> The biologists talk about how lucky they were to get a 5% discount on their train tickets. 
> The statisticians responded: "We've paid even less – we've bought only one ticket for all three of us!"  
> "How so?" – the biologists got confused. "You'll see". 
> When the statisticians notice the ticket controller appear in the car, all of them quickly go
> to a lavatory and close the door. When the controller sees the lavatory is occupied, he knocks 
> on the door, the statisticians give him the (single) ticket through a small gap below the door.
> Biologists are amazed seeing this. 
>
> After the conference, the biologists buy only one ticket
> for the return home and want to use the statisticians' method. 
> They meet with the same 3 statisticians in the compartment and 
> tell them their plan. The statisticians respond: "Well, that's a nice idea, but we've already 
> improved our method. See, this time we've bought no tickets at all!". "How so?!". "You'll see".
> When the controller appears, the biologists rush to the lavatory. The statisticians follow them
> and knock on the door. The biologists give the ticket they've bought, the statisticians take it
> and lock themselves in another lavatory. 
> The conclusion: don't use statistical methods you don't understand!

The Central Limit Theorem holds if results of each experiment $$X_i$$ 
have the same distribution and are independent from each other. Unfortunately often neither 
of these assumption holds in the real world.

Imagine the benchmark code is executed on a computer with a CPU that has some kind of "turbo mode"
i.e. the operating system boosts its frequency if the CPU is cool, but then lowers it once it heats up.
When running a sequence of experiments on such a machine, the results obtained at the beginning
of the sequence would likely have different expected value than the results obtained near the end.
The longer you run the experiment and the more data points you collect, the lower the mean performance
would be, because the initial data points that were collected when the CPU frequency was boosted would 
matter less relative to all the collected data. The best way of fixing that problem is to run 
the benchmarks in an environment that doesn't change performance in response to the load generated 
by the benchmark. However, after turning off any turbo modes and locking the CPU frequency to a 
constant value, the variability of the results was still a lot larger than what the standard error 
predicted. 

Let's look closer at where the formula for $$s_{\bar{x}}$$ is coming from. 
Assume we draw a sample $$\{x_1, x_2, ..., x_N\}$$ from a sequence of random
variables $$\{X_1, X_2, ..., X_N\}$$. A sequence of such variables is called a *stochastic process*.
Let's assume variables $$X_i$$ are eqally distributed and have a finite expected value and variance: 

$$\mathrm{E}X_1 = \mathrm{E}X_2 = ... = \mathrm{E}X_N = \mathrm{E}X \tag{1} $$

$$\mathrm{Var}X_1 = \mathrm{Var}X_2 = ... = \mathrm{Var}X_N = \mathrm{Var}X \tag{2} $$

Let $$\bar{X}$$ be the random variable denoting the mean of all the observations:

$$\bar{X} = \frac{1}{N}\sum_{i = 1}^{N}X_i$$

From (1) we can conclude that our mean will have the same expected value as the expected value
of $$X$$:

$$\mathrm{E}\bar{X} = \frac{1}{N}\sum_{i = 1}^N\mathrm{E}X_i = \frac{1}{N}N\mathrm{E}X = \mathrm{E}X$$

What about variance? We can use (2) in a similar way, however one must be careful when taking constants out 
from under the variance, because they become squared:

$$\mathrm{Var}\bar{X} = \mathrm{Var}\left(\frac{1}{N}\sum_{i = 1}^{N}X_i\right) = 
  \frac{1}{N^2}\mathrm{Var}\left(\sum_{i = 1}^{N}X_i\right)$$ 

If we additionally assume that $$X_i$$ is independent from $$X_j$$ for $$i \neq j$$, the variance of a sum of variables 
is equal to the sum of their variances, hence we obtain:

$$\mathrm{Var}\bar{X} = \frac{1}{N^2}\sum_{i = 1}^{N}\mathrm{Var}X_i = \frac{N}{N^2}\mathrm{Var}X = \frac{1}{N} \mathrm{Var}X \tag{3}$$

Finally, standard deviation $$s$$ is the square root of the variance:

$$s_{\bar{X}} = \frac{1}{\sqrt{N}}\sqrt{\mathrm{Var}X} = \frac{s}{\sqrt{N}}$$

which is the formula that's used to compute the standard error we mentioned earlier.

However, if $${X_i}$$ is not independent from $${X_j}$$ for any $$i \neq j$$, then the formula
(3) is incorrect, because the variance of a sum is not the sum of variances! The general formula for summing variances is 
a bit more complex and contains additional covariance terms:

$$\mathrm{Var}\left(\sum_{i = 1}^{N}X_i\right) = \sum_{i = 1}^N\sum_{j = 1}^N \mathrm{Cov}(X_i, X_j) = 
\sum_{i = 1}^{N}\mathrm{Var}X_i + 2 \sum_{i = 2}^N\sum_{j < i} \mathrm{Cov(X_i, X_j)}$$

After dividing by $$N^2$$ we get:

$$\mathrm{Var}\bar{X} = \frac{1}{N^2}\sum_{i = 1}^N\sum_{j = 1}^N \mathrm{Cov}(X_i, X_j) = 
\frac{1}{N}\left(\mathrm{Var}X + \frac{2}{N} \sum_{i = 2}^N\sum_{j < i} \mathrm{Cov(X_i, X_j)}\right) \tag{4}$$

We can see that any dependency between experiments can cause the second term to become non-zero. 
If variables $$X_i$$ are positively correlated, the covariance term will be positive and the actual
variance of the mean would be larger. In extreme case, if all data points 
were 100% positively correlated with each other, that is $$\mathrm{Cov}(X_i, X_j) = \mathrm{Var}(X)$$ for all $$i$$ and $$j$$, formula (4) would become:

$$\mathrm{Var}\bar{X} = \mathrm{Var}X $$

This means dependence between the results makes the *effective size of the sample* smaller than $$N$$. 
In the extreme case it can make effective $$N$$ equal 1, regardless of the number of the observations we make.

There is a good thought experiment that can explain this phenomenon without formulas.
Imagine you're periodically checking the outside temperature to compute the yearly average. 
In experiment A you take a measurement once per second. In experiment B, you take a measurement
every 10 ms, so you get 100 more data points than in experiment A. But can you really say 
the expected error of the yearly average is really $$\sqrt{100}$$ times lower in experiment B than in A?
You can't conclude that, because there is an extremely strong correlation between measurements 
taken with such a high frequency and many of your data points are just exactly the same. 
By sampling every 10 ms, you artificially increased the number of data points, 
but due to strong autocorrelation, the amount of real information you collected didn't really increase (much).

This problem exists in benchmarking as well, although it is probably not as strong as with the weather.
Imagine that during the test, the operating system decides to put the benchmarking process
on hold for a while and perform another unrealated task. Or a JVM decides to start GC. Or Cassandra starts flushing a memtable.
If our data point is just a single database request, then
several hundreds requests executed at that time can be affected. This makes response times not truly independent from
each other.

# Better Estimate Of Variance Of The Mean
Let's put formula (4) into practice. We need to find a way to compute these $$\mathrm{Cov}(X_i, X_j)$$ terms.
The nested sum looks a bit scary though, and estimating covariance from data itself requires $$O(N)$$ steps, so 
altogether it would be $$O(N^3)$$.

We can simplify it a bit by adding an assumption that our stochastic process $$X$$ is *weakly stationary*, i.e. its basic 
statistical properties like mean, variance and autocovariance do not change when shifted in time.
In this case not only $$\mathrm{E}X_i = \mathrm{E}X_{i + \tau}$$ and $$\mathrm{Var}X_i = \mathrm{Var}X_{i + \tau}$$ but also 
$$\mathrm{Cov}(X_{i}, X_{j}) = \mathrm{Cov}(X_{i + \tau}, X_{j + \tau})$$ for all values of $$i$$ and $$\tau$$.

For convenience, let's define autocovariance with lag $$k$$ as:

$$\gamma_X(k) = \mathrm{Cov}(X_{1}, X_{1 + k}) = \mathrm{Cov}(X_{2}, X_{2 + k}) = ... = \mathrm{Cov}(X_{N - k}, X_{N})$$

$$\gamma_X(0) = \mathrm{Var}X $$

And now we can rewrite formula (4) into:

$$\mathrm{Var}\bar{X} = \frac{1}{N}\left(\gamma_X(0) + \frac{2}{N} \sum_{k = 1}^{N-1} (N - k)\gamma_X(k)\right) \tag{5}$$

Note the term $$(N - k)$$ that replaces the inner loop in (4). There are $$(N - k)$$ pairs $$(X_i, X_{i+k})$$ in our series $$X$$.

We can estimate variance and autocovariance from the data:

$$\hat{\gamma}_X(k) = \frac{1}{N}\sum_{i = 1}^{N - k}(x_i - \bar{x})(x_{i+k} - \bar{x}) $$

Finally, the autocovariance-corrected formula for empirical error of the mean is:

$$\hat{s}_{\bar{X}} = \sqrt{\frac{1}{N}\left(\hat{\gamma}_X(0) + \frac{2}{N} \sum_{k = 1}^{N-1} (N - k)\hat{\gamma}_X(k)\right)} \tag{6} $$

# Another Trap
Recipe (6) has a few problems when transformed directly into code:
- the complexity is $$O(N^2)$$, which is practical only for thousands of data points, but probably not for millions
- autocovariances with higher lag $$k$$ add a lot of noise because they are computed from fewer data points than autocovariances with low $$k$$
- autocovariances $$\hat{\gamma}$$ are estimated from the same data, and, guess what, they are... autocorrelated! :D

A method that works reasonably well in practice is limiting $$k$$ to a value much lower than $$N$$, e.g. $$\sqrt{N}$$: 

$$\hat{s}_{\bar{X}} = \sqrt{\frac{1}{N}\left(\hat{\gamma}_X(0) + \frac{2}{N} \sum_{k = 1}^{\sqrt{N}} (N - k)\hat{\gamma}_X(k)\right)}$$

This is based on the assumption that data points that are distant in time are much less correlated with each other 
than points that are close to each other, therefore truncating these higher-lag autocovariances doesn't remove much useful information. 
This assumption is not true in general case, however, many stochastic processes we can observe in practice in benchmarking have such property or are "close enough". 
You will need a bit of experimentation to find out the best lag cut-off for your system. 
Additionally, a nice side-effect of limiting the number of autocovariance terms is reducing the asymptotic complexity.

Another, more general method is multiplying autocovariance terms by diminishing weights less than 1, approaching zero when $$k$$ reaches a hard 
limit. A list of various weighting schemes is given by [[1]](#Andrews1991). You can also find a broader discussion about applying this formula
in [[2]](#Okui2010). 

# Code
Putting it all together, we can write the following function for estimating error of the mean:

```rust
pub fn error_of_the_mean(v: &[f64]) -> f64 {
    if v.len() <= 1 {
        return f64::NAN;
    }
    let len = v.len() as f64;

    let mut mean = 0.0;
    for &x in v.iter() {
        mean += x;
    }
    mean /= len;

    let mut var = 0.0;
    for &x in v.iter() {
        let diff = x - mean;
        var += diff * diff;
    }
    var /= len;

    let bandwidth = len.powf(0.5);
    let max_lag = min(v.len(), bandwidth.ceil() as usize);
    let mut cov = 0.0;
    for lag in 1..max_lag {
        let weight = 1.0 - lag / len;
        for i in lag..v.len() {
            let diff_1 = v[i] - mean;
            let diff_2 = v[i - lag] - mean;
            cov += 2.0 * diff_1 * diff_2 * weight;
        }
    }
    cov /= len;

    ((var + cov).max(0.0) / len).sqrt()
}
```

# References
1. <a name="Andrews1991"></a> D. W. K. Andrews, “Heteroskedasticity and Autocorrelation Consistent Covariance Matrix Estimation,” Econometrica, vol. 59, no. 3, pp. 817–858, 1991.
2. <a name="Okui2010"></a> R. Okui, “Asymptotically Unbiased Estimation Of Autocovariances And Autocorrelations With Long Panel Data,” Econometric Theory, vol. 26, no. 5, pp. 1263–1304, 2010.

