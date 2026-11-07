"""Writes a small synthetic workbook for the e2e checks: python e2e/make_sample.py OUT.xlsx
Common words only, made up for tests; the colour layout mirrors Hugo's real file (see .claude/plans/2026-11-07-sheets.md):
  HSK四级  ID, Hanzi, Pinyin, English; only A-B are filled (C5E0B4 green, EEA6A6 pink, FDF95F yellow, or none)
  HSK五级  A-D filled A9D18E (green), FFFF00 (yellow), FF0000 (red), theme 4 tint 0.4 (blue), plus blank rows
  Grammar  Pattern, English, Example
No personal data. Needs openpyxl. Never commit the output."""
import sys
from openpyxl import Workbook
from openpyxl.styles import PatternFill
from openpyxl.styles.colors import Color

HSK4 = [
    ('你好', 'nǐ hǎo', 'hello'), ('谢谢', 'xièxie', 'thank you'), ('再见', 'zàijiàn', 'goodbye'),
    ('请', 'qǐng', 'please'), ('对不起', 'duìbuqǐ', 'sorry'), ('没关系', 'méi guānxi', 'it does not matter'),
    ('我', 'wǒ', 'I, me'), ('你', 'nǐ', 'you'), ('他', 'tā', 'he'), ('她', 'tā', 'she'),
    ('们', 'men', 'plural marker'), ('是', 'shì', 'to be'), ('不', 'bù', 'not'), ('有', 'yǒu', 'to have'),
    ('好', 'hǎo', 'good'), ('大', 'dà', 'big'), ('小', 'xiǎo', 'small'), ('多', 'duō', 'many'),
]
HSK5 = [
    ('少', 'shǎo', 'few'), ('人', 'rén', 'person'), ('水', 'shuǐ', 'water'), ('茶', 'chá', 'tea'),
    ('米饭', 'mǐfàn', 'cooked rice'), ('吃', 'chī', 'to eat'), ('喝', 'hē', 'to drink'),
    ('看', 'kàn', 'to look'), ('说', 'shuō', 'to speak'), ('去', 'qù', 'to go'), ('来', 'lái', 'to come'),
    ('今天', 'jīntiān', 'today'), ('明天', 'míngtiān', 'tomorrow'), ('学校', 'xuéxiào', 'school'),
    ('老师', 'lǎoshī', 'teacher'), ('朋友', 'péngyou', 'friend'), ('中国', 'Zhōngguó', 'China'),
    ('大', 'dà', 'big'),   # also on HSK四级: one word, two rows
]


def solid(rgb=None, theme=None, tint=0.0):
    return PatternFill('solid', fgColor=Color(rgb='FF' + rgb) if rgb else Color(theme=theme, tint=tint))


# HSK四级: colour of A-B per row, cycling; None = no fill.
FILLS4 = [solid('C5E0B4'), solid('EEA6A6'), solid('FDF95F'), None]
# HSK五级: colour of A-D per row, cycling; None = blank row (the e2e sets one of these to Mastered).
FILLS5 = [solid('A9D18E'), solid('FFFF00'), solid('FF0000'), solid(theme=4, tint=0.4), None, None]

wb = Workbook()
ws = wb.active
ws.title = 'HSK四级'
ws.append(['ID', 'Hanzi', 'Pinyin', 'English'])
for i, (h, p, e) in enumerate(HSK4, 1):
    ws.append([i, h, p, e])
    f = FILLS4[(i - 1) % len(FILLS4)]
    if f:
        for col in (1, 2):
            ws.cell(row=i + 1, column=col).fill = f

w5 = wb.create_sheet('HSK五级')
w5.append(['ID', 'Hanzi', 'Pinyin', 'English'])
for i, (h, p, e) in enumerate(HSK5, 1):
    w5.append([i, h, p, e])
    f = FILLS5[(i - 1) % len(FILLS5)]
    if f:
        for col in range(1, 5):
            w5.cell(row=i + 1, column=col).fill = f

g = wb.create_sheet('Grammar')
g.append(['Pattern', 'English', 'Example'])
g.append(['不 + verb', 'negation', '我不吃肉。'])
g.append(['是……的', 'emphasis on how or when', '我是昨天来的。'])
g.append(['有 + noun', 'to have', '我有一个朋友。'])

wb.save(sys.argv[1] if len(sys.argv) > 1 else 'sample.xlsx')
