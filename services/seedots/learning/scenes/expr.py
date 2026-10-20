"""A tiny, safe math expression language shared by the server (validation, computing the
truth of predictions) and the browser (apps/web/lib/expr.ts implements the same grammar).

    expr   := sum
    sum    := prod (("+" | "-") prod)*
    prod   := unary (("*" | "/") unary)*
    unary  := "-" unary | power
    power  := atom ("^" unary)?
    atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"

Names are variables (scene parameters, x, the iteration state) or the constants pi, e.
Functions are a fixed whitelist. Nothing else is reachable: no attribute access, no eval.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Union

FUNCS = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "exp": math.exp, "log": math.log, "sqrt": math.sqrt,
    "abs": abs, "min": min, "max": max, "pow": math.pow, "tanh": math.tanh, "atan": math.atan,
    "sign": lambda v: (v > 0) - (v < 0), "floor": math.floor,
}
ARITY = {"min": (2, 4), "max": (2, 4), "pow": (2, 2)}
CONSTS = {"pi": math.pi, "e": math.e}
TOKEN = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(.))")
MAX_LEN = 240


class ExprError(ValueError):
    pass


@dataclass(frozen=True)
class Num:
    v: float


@dataclass(frozen=True)
class Var:
    name: str


@dataclass(frozen=True)
class Call:
    fn: str
    args: tuple["Node", ...]


@dataclass(frozen=True)
class Bin:
    op: str
    a: "Node"
    b: "Node"


@dataclass(frozen=True)
class Neg:
    a: "Node"


Node = Union[Num, Var, Call, Bin, Neg]


def _tokens(src: str) -> list[tuple[str, str]]:
    if len(src) > MAX_LEN:
        raise ExprError("expression is too long")
    out = []
    pos = 0
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            break
        num, name, op = m.groups()
        if num is not None:
            out.append(("num", num))
        elif name is not None:
            out.append(("name", name))
        elif op is not None and op.strip():
            if op not in "+-*/^(),":
                raise ExprError(f"unexpected character {op!r}")
            out.append(("op", op))
        pos = m.end()
    out.append(("end", ""))
    return out


class _Parser:
    def __init__(self, src: str):
        self.t = _tokens(src)
        self.i = 0

    def peek(self) -> tuple[str, str]:
        return self.t[self.i]

    def take(self, kind: str | None = None, value: str | None = None) -> tuple[str, str]:
        tok = self.t[self.i]
        if (kind and tok[0] != kind) or (value and tok[1] != value):
            raise ExprError(f"expected {value or kind}, found {tok[1] or 'end'}")
        self.i += 1
        return tok

    def parse(self) -> Node:
        node = self.sum()
        self.take("end")
        return node

    def sum(self) -> Node:
        node = self.prod()
        while self.peek() in (("op", "+"), ("op", "-")):
            op = self.take()[1]
            node = Bin(op, node, self.prod())
        return node

    def prod(self) -> Node:
        node = self.unary()
        while self.peek() in (("op", "*"), ("op", "/")):
            op = self.take()[1]
            node = Bin(op, node, self.unary())
        return node

    def unary(self) -> Node:
        if self.peek() == ("op", "-"):
            self.take()
            return Neg(self.unary())
        if self.peek() == ("op", "+"):
            self.take()
            return self.unary()
        return self.power()

    def power(self) -> Node:
        base = self.atom()
        if self.peek() == ("op", "^"):
            self.take()
            return Bin("^", base, self.unary())
        return base

    def atom(self) -> Node:
        kind, val = self.peek()
        if kind == "num":
            self.take()
            return Num(float(val))
        if kind == "name":
            self.take()
            if self.peek() == ("op", "("):
                if val not in FUNCS:
                    raise ExprError(f"unknown function {val!r}")
                self.take()
                args = [self.sum()]
                while self.peek() == ("op", ","):
                    self.take()
                    args.append(self.sum())
                self.take("op", ")")
                lo, hi = ARITY.get(val, (1, 1))
                if not lo <= len(args) <= hi:
                    raise ExprError(f"{val} takes {lo}{'' if lo == hi else f'-{hi}'} argument(s)")
                return Call(val, tuple(args))
            return Var(val)
        if (kind, val) == ("op", "("):
            self.take()
            node = self.sum()
            self.take("op", ")")
            return node
        raise ExprError(f"unexpected {val or 'end of expression'}")


def parse(src: str) -> Node:
    return _Parser(src).parse()


def names(node: Node) -> set[str]:
    if isinstance(node, Var):
        return {node.name}
    if isinstance(node, Call):
        return set().union(*(names(a) for a in node.args))
    if isinstance(node, Bin):
        return names(node.a) | names(node.b)
    if isinstance(node, Neg):
        return names(node.a)
    return set()


def evaluate(node: Node, env: dict[str, float]) -> float:
    """Returns nan instead of raising on domain errors (log(-1), 1/0)."""
    try:
        return _ev(node, env)
    except (ZeroDivisionError, ValueError, OverflowError):
        return math.nan


def _ev(n: Node, env: dict[str, float]) -> float:
    if isinstance(n, Num):
        return n.v
    if isinstance(n, Var):
        if n.name in env:
            return env[n.name]
        if n.name in CONSTS:
            return CONSTS[n.name]
        raise ExprError(f"unknown name {n.name!r}")
    if isinstance(n, Neg):
        return -_ev(n.a, env)
    if isinstance(n, Call):
        return float(FUNCS[n.fn](*(_ev(a, env) for a in n.args)))
    a, b = _ev(n.a, env), _ev(n.b, env)
    if n.op == "+":
        return a + b
    if n.op == "-":
        return a - b
    if n.op == "*":
        return a * b
    if n.op == "/":
        return a / b
    r = a ** b
    if isinstance(r, complex):
        raise ValueError("complex result")
    return float(r)


def check(src: str, allowed: set[str]) -> Node:
    """Parse and make sure only allowed variable names appear."""
    node = parse(src)
    unknown = names(node) - allowed - set(CONSTS)
    if unknown:
        raise ExprError(f"unknown name(s): {', '.join(sorted(unknown))}")
    return node
