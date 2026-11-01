#!/usr/bin/env python3
"""
Streaming merge-diff of two sorted domain files.
Writes domains in A but not B to outPath.
O(1) memory regardless of file size.
"""

import sys


def main():
    path_a, path_b, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    count = 0
    last_reported = 0   # last 100k milestone already logged (avoid per-iteration spam)

    with open(path_a, 'r', buffering=1 << 20) as fa, \
         open(path_b, 'r', buffering=1 << 20) as fb, \
         open(out_path, 'w', buffering=1 << 20) as fout:

        a_line = fa.readline()
        b_line = fb.readline()

        while a_line:
            av = a_line.strip()

            if not av:
                a_line = fa.readline()
                continue

            if not b_line:
                # B exhausted: remaining entries in A are absent from B.
                fout.write(av + '\n')
                count += 1
                a_line = fa.readline()
                continue

            bv = b_line.strip()

            if not bv:
                b_line = fb.readline()
                continue

            if av < bv:
                fout.write(av + '\n')
                count += 1
                a_line = fa.readline()

            elif av == bv:
                a_line = fa.readline()
                b_line = fb.readline()

            else:
                b_line = fb.readline()

            if count // 100_000 > last_reported:
                last_reported = count // 100_000
                print(
                    f'[DIFF] {count:,} drops found so far...',
                    flush=True
                )

    print(
        f'[DIFF] done: {count:,} dropped records written to {out_path}',
        flush=True
    )


if __name__ == '__main__':
    main()
