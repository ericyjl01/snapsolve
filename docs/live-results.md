# Live results — the system prompt on real `claude` (task 012)

Measured 2026-10-14 on Windows 11 with Claude Code 2.1.300 (claude.ai plan login, no API key). `npm run test:live` drives
the real runner (SPEC §3.1 flags, `prompts/system.md`, effort high) on the four screenshots in `test/fixtures/problems/`;
the sonnet run sets `SNAPSOLVE_LIVE_MODEL=sonnet`. Turn time is wall clock from enqueue to the end of the turn; TTFT and
cost are what `claude` reported (cost is the API-equivalent figure — the plan is billed, not an API key). Correctness was
judged by hand and agrees with the test's checks.

## Summary (final prompt)

| Model / effort | Turns | Correct answer line + all format checks | Turn time median / max | TTFT median | Cost per turn (median) | Answer lines |
|---|---|---|---|---|---|---|
| opus / high | 8 | 8/8 | 5.0 s / 8.4 s | 2.8 s | $0.025 | 7–19 |
| sonnet / high | 4 | 3/4 | 3.9 s / 4.2 s | 2.7 s | $0.012 | 7–22 |

- **opus / high: 8/8** over two consecutive runs (the "passes twice in a row" check). Every answer leads with
  `**Answer:** …`, then numbered steps and a `**Check:**` line; no preamble, no HTML. Across all 20 opus turns of this
  task (every prompt draft) no answer line was wrong.
- **sonnet / high: 3/4.** Its algebra answer line said `x = 21/5 (or 4.2)`; the steps reached x = 7 and the body added
  "Correction to the answer line: step 5 gives x = 7". On the previous draft its rates answer line said 36/5 h and was
  corrected the same way. Sonnet commits to the answer line before working the problem (2 wrong answer lines in 8
  turns); its steps and checks were right every time. About half the cost and 1 s faster per turn than opus.

## How the prompt got here

1. DESIGN §3.4 draft verbatim: opus 4/4. Its example (`3(x − 4) + 2x = 2x + 9 → x = 7`) is the algebra fixture itself,
   so the example became `2(x + 3) = 5x − 6 → x = 4`.
2. New example: opus 4/4, then 3/4 — the code-bug answer line described the bug ("the loop starts at index 1") without
   quoting the faulty line. Added: "A bug in code: the answer line quotes the faulty line and states the fix; then show
   the corrected code." Sonnet 2/4 on this draft: rates answer line 36/5 h (wrong); algebra `x = \dfrac{21}{3} = 7`
   (right — the test's pattern rejected it and was fixed in 01f3e3d).
3. Final prompt: opus 4/4 twice in a row; sonnet 3/4. The answers follow.

## Answers (final prompt)

### opus run 1

#### algebra — 5.4 s, TTFT 2.5 s, $0.0242, checks: all pass

````markdown
**Answer:** $x = 7$

1. Distribute: $3x - 12 + 2x = 2x + 9$
2. Combine like terms: $5x - 12 = 2x + 9$
3. Subtract $2x$ from both sides: $3x - 12 = 9$
4. Add $12$ to both sides: $3x = 21$
5. Divide by $3$: $x = 7$

**Check:** $3(7 - 4) + 2(7) = 9 + 14 = 23$ and $2(7) + 9 = 23$ ✓
````

#### rates — 8.4 s, TTFT 3.4 s, $0.0280, checks: all pass

````markdown
**Answer:** $\dfrac{36}{7}$ hours ≈ **5.14 hours** (about 5 h 9 min)

1. Rates in tanks per hour: A $= \tfrac16$, B $= \tfrac19$, drain $= -\tfrac1{12}$.
2. Net rate: $\tfrac16 + \tfrac19 - \tfrac1{12} = \tfrac{6}{36} + \tfrac{4}{36} - \tfrac{3}{36} = \tfrac{7}{36}$ tank per hour.
3. Time to fill 1 tank: $t = \dfrac{1}{7/36} = \dfrac{36}{7} = 5\tfrac17$ h. Since $\tfrac17$ h ≈ 8.6 min, that is about 5 h 9 min.

**Check:** $\tfrac{36}{7}\left(\tfrac16+\tfrac19-\tfrac1{12}\right) = \tfrac{6}{7}+\tfrac{4}{7}-\tfrac{3}{7} = 1$ tank ✓
````

#### code-bug — 5.4 s, TTFT 4.2 s, $0.0256, checks: all pass

````markdown
**Answer:** Line 3, `for i in range(1, len(nums)):`, starts at index 1, so it skips the first element. Change it to `range(len(nums))`, or loop over the values directly.

1. `range(1, 3)` gives indices 1 and 2, so only `8 + 6 = 14` is added and `nums[0] = 4` is left out.
2. The function still divides by all 3 elements: $14 / 3 = 4.\overline{6}$. That matches the terminal output.
3. Fix it by including index 0. The simplest version uses `sum`:

```python
def average(nums):
    total = 0
    for x in nums:
        total += x
    return total / len(nums)

print(average([4, 8, 6]))  # 6.0
```

A shorter version is `return sum(nums) / len(nums)`.

**Check:** $(4 + 8 + 6) / 3 = 18 / 3 = 6.0$ ✓
````

#### multiple-choice — 3.9 s, TTFT 2.9 s, $0.0228, checks: all pass

````markdown
**Answer:** C) 29

1. 21 = 3 × 7, so it is not prime.
2. 27 = 3 × 9, so it is not prime.
3. 33 = 3 × 11, so it is not prime.
4. 29: since $\sqrt{29} < 6$, you only need to test 2, 3 and 5. None of them divides 29, so it is prime.

**Check:** 29 is odd, its digit sum 11 is not a multiple of 3, and it doesn't end in 0 or 5 ✓
````

### opus run 2

#### algebra — 4.1 s, TTFT 1.4 s, $0.0244, checks: all pass

````markdown
**Answer:** $x = 7$

1. Distribute: $3x - 12 + 2x = 2x + 9$
2. Combine like terms: $5x - 12 = 2x + 9$
3. Subtract $2x$ from both sides: $3x - 12 = 9$
4. Add 12 to both sides: $3x = 21$
5. Divide by 3: $x = 7$

**Check:** Left side is $3(7-4) + 2(7) = 9 + 14 = 23$. Right side is $2(7) + 9 = 23$ ✓
````

#### rates — 5.8 s, TTFT 1.6 s, $0.0277, checks: all pass

````markdown
**Answer:** $\dfrac{36}{7}$ hours ≈ 5.14 hours (about 5 h 9 min)

1. Hourly rates, in tanks per hour:
   - Pipe A: $+\frac{1}{6}$
   - Pipe B: $+\frac{1}{9}$
   - Drain: $-\frac{1}{12}$, negative because it empties the tank.
2. Combined rate, using denominator 36:
   $$\frac{6}{36}+\frac{4}{36}-\frac{3}{36}=\frac{7}{36}\text{ tank per hour}$$
3. Time to fill one tank:
   $$t=\frac{1}{7/36}=\frac{36}{7}\approx 5.14\text{ h}$$

**Check:** In $\frac{36}{7}$ h, A fills $\frac{6}{7}$, B fills $\frac{4}{7}$, and the drain removes $\frac{3}{7}$. Then $\frac{6+4-3}{7}=1$ tank ✓
````

#### code-bug — 4.5 s, TTFT 3.6 s, $0.0255, checks: all pass

````markdown
**Answer:** Line 3, `for i in range(1, len(nums)):`, starts at index 1, so it skips `nums[0]`. Change it to `range(len(nums))`, or loop over the values directly.

1. With `range(1, 3)` the loop only adds `nums[1] + nums[2] = 8 + 6 = 14`. The `4` is never added.
2. It then divides by all 3 elements: $14 / 3 = 4.\overline{6}$, which is the output you saw.
3. Starting the loop at index 0 includes every element.

```python
def average(nums):
    total = 0
    for n in nums:
        total += n
    return total / len(nums)

print(average([4, 8, 6]))  # 6.0
```

A shorter version: `return sum(nums) / len(nums)`.

**Check:** $(4 + 8 + 6) / 3 = 18 / 3 = 6.0$ ✓
````

#### multiple-choice — 4.4 s, TTFT 2.8 s, $0.0229, checks: all pass

````markdown
**Answer:** C) 29

1. 21 = 3 × 7, so it is not prime.
2. 27 = 3 × 9, so it is not prime.
3. 33 = 3 × 11, so it is not prime.
4. 29: since $\sqrt{29} < 6$, only 2, 3 and 5 need testing. None of them divides 29, so it is **prime**.

**Check:** 29 is odd, its digit sum 11 is not a multiple of 3, and it doesn't end in 0 or 5 ✓
````

### sonnet run 1

#### algebra — 3.7 s, TTFT 2.6 s, $0.0123, checks: failed answerFirst

````markdown
**Answer:** $x = \dfrac{21}{5}$ (or $4.2$)

1. Distribute: $3x - 12 + 2x = 2x + 9$
2. Combine like terms on the left: $5x - 12 = 2x + 9$
3. Subtract $2x$ from both sides: $3x - 12 = 9$
4. Add $12$ to both sides: $3x = 21$
5. Divide by $3$: $x = 7$

Correction to the answer line: step 5 gives $x = 7$, not $\frac{21}{5}$.

**Final answer:** $x = 7$

**Check:** Left: $3(7-4) + 2(7) = 9 + 14 = 23$. Right: $2(7) + 9 = 23$ ✓
````

#### rates — 4.2 s, TTFT 3.1 s, $0.0128, checks: all pass

````markdown
**Answer:** $\dfrac{36}{7}$ hours ≈ 5.14 hours (about 5 hours 9 minutes)

1. Rates (tank per hour): A fills $\tfrac16$, B fills $\tfrac19$, the drain empties $\tfrac1{12}$.
2. Net rate: $\tfrac16+\tfrac19-\tfrac1{12} = \tfrac{6}{36}+\tfrac{4}{36}-\tfrac{3}{36} = \tfrac{7}{36}$ tank/hour.
3. Time: $t = 1 \div \tfrac{7}{36} = \tfrac{36}{7}$ hours.

**Check:** $\tfrac{7}{36}\cdot\tfrac{36}{7} = 1$ full tank ✓. 0.14 h × 60 ≈ 9 min, so about 5 h 9 min.
````

#### code-bug — 4.0 s, TTFT 2.9 s, $0.0122, checks: all pass

````markdown
**Answer:** Line 3, `for i in range(1, len(nums)):`, starts at index 1, so it skips `nums[0]`. Change it to `range(len(nums))`.

Here is why the output is 4.666…: the loop sums only 8 + 6 = 14, and 14 / 3 ≈ 4.667.

```python
def average(nums):
    total = 0
    for i in range(len(nums)):
        total += nums[i]
    return total / len(nums)

print(average([4, 8, 6]))  # prints 6.0
```

Or more simply:

```python
def average(nums):
    return sum(nums) / len(nums)
```

**Check:** (4 + 8 + 6) / 3 = 18 / 3 = 6.0 ✓
````

#### multiple-choice — 3.2 s, TTFT 2.1 s, $0.0113, checks: all pass

````markdown
**Answer:** C) 29

1. A) 21 = 3 × 7 → composite
2. B) 27 = 3 × 9 → composite
3. C) 29: not divisible by 2, 3, or 5, and √29 ≈ 5.4, so no other divisors need checking → prime
4. D) 33 = 3 × 11 → composite

**Check:** The only primes up to 5 are 2, 3, and 5. None of them divides 29, so it is prime ✓
````
