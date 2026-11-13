import sys; sys.path.insert(0, '.')
from calc import evaluate
from fractions import Fraction as F
cases = [("1+2*3", 7), ("(1+2)*3", 9), ("2^3^2", 512), ("-2^2", -4), ("(-2)^2", 4), ("--3", 3), ("7/2", F(7,2)),
 ("1 - 2 - 3", -4), ("2*-3", -6), ("x*2+y", 11, {"x": 4, "y": 3}), ("2^-1", F(1,2)), ("((((1))))", 1),
 ("10/4*2", 5), (" 3 ", 3), ("1.5*2", 3), ("max(1, 5, 3)", 5), ("min(4,max(2,3))", 3), ("2(3)", "err"),
 ("1/0", "err"), ("1+", "err"), ("(1", "err"), ("foo", "err"), ("", "err"), ("1 2", "err"), ("max()", "err")]
ok = 0
for c in cases:
    expr, want = c[0], c[1]; vars = c[2] if len(c) > 2 else {}
    try:
        got = evaluate(expr, vars)
        good = want != "err" and F(got) == F(want)
    except ValueError:
        good = want == "err"
    except Exception:
        good = False
    ok += good
print(f"{ok}/{len(cases)}")
