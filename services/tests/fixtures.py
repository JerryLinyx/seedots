YOUTUBE_AUTO_VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.869 align:start position:0%
 
so<00:00:00.480><c> today</c><00:00:00.640><c> we</c><00:00:00.799><c> talk</c><00:00:01.000><c> about</c><00:00:01.300><c> gradient</c><00:00:01.600><c> descent</c>

00:00:02.869 --> 00:00:02.879 align:start position:0%
so today we talk about gradient descent


00:00:02.879 --> 00:00:05.990 align:start position:0%
so today we talk about gradient descent
the<00:00:03.120><c> learning</c><00:00:03.400><c> rate</c><00:00:03.700><c> controls</c><00:00:04.000><c> the</c><00:00:04.200><c> step</c><00:00:04.400><c> size</c>

00:00:05.990 --> 00:00:06.000 align:start position:0%
the learning rate controls the step size


00:00:09.000 --> 00:00:11.500 align:start position:0%
the learning rate controls the step size
if<00:00:09.300><c> it</c><00:00:09.500><c> is</c><00:00:09.700><c> too</c><00:00:09.900><c> large</c><00:00:10.200><c> the</c><00:00:10.400><c> loss</c><00:00:10.700><c> diverges</c>
"""

SRT = """1
00:00:01,000 --> 00:00:04,000
Gradient descent walks downhill. Each step follows the negative gradient.

2
00:00:04,500 --> 00:00:07,000
The learning rate sets how far each step goes.

3
00:00:07,200 --> 00:00:10,000
If the learning rate is too large, the loss can oscillate or diverge.
"""


def long_vtt(n: int = 40, template: str = "Sentence {i} explains how the {topic} behaves during training.",
             topics: tuple[str, ...] = ("gradient descent", "learning rate", "loss function", "momentum")) -> str:
    """A clean, punctuated caption track with n sentences, 6s apart, about a few concepts."""
    lines = ["WEBVTT", ""]
    for i in range(n):
        t0, t1 = i * 6, i * 6 + 5
        topic = topics[(i // 10) % len(topics)]
        lines += [f"00:{t0 // 60:02d}:{t0 % 60:02d}.000 --> 00:{t1 // 60:02d}:{t1 % 60:02d}.000",
                  template.format(i=i, topic=topic), ""]
    return "\n".join(lines)
