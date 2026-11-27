"""Writes a synthetic, Hugo-sized workbook for e2e/perf.py: python e2e/make_big.py OUT.xlsx
HSK四级 570 words, HSK五级 1,200 words, Grammar 40 points (1,810 notes). Deterministic (seeded), made up from a built-in table
of ~60 common characters; every word is an ordered pair of two different characters (hanzi c1c2, pinyin p1p2, English g1 g2),
unique across both sheets. Same headers and colour cycles as make_sample.py. No personal data. Needs openpyxl. Never commit the output.

From Python: make(path, hsk4=570, hsk5=1200, grammar=40) writes the file and returns {'HSK四级': first hanzi, 'HSK五级': ...}."""
import random
import sys
from openpyxl import Workbook
from openpyxl.styles import PatternFill
from openpyxl.styles.colors import Color

# character, pinyin, one-word gloss
CHARS = [
    ('人', 'rén', 'person'), ('大', 'dà', 'big'), ('小', 'xiǎo', 'small'), ('山', 'shān', 'hill'), ('水', 'shuǐ', 'water'),
    ('火', 'huǒ', 'fire'), ('木', 'mù', 'wood'), ('土', 'tǔ', 'earth'), ('日', 'rì', 'sun'), ('月', 'yuè', 'moon'),
    ('天', 'tiān', 'sky'), ('地', 'dì', 'ground'), ('风', 'fēng', 'wind'), ('雨', 'yǔ', 'rain'), ('云', 'yún', 'cloud'),
    ('花', 'huā', 'flower'), ('草', 'cǎo', 'grass'), ('鸟', 'niǎo', 'bird'), ('鱼', 'yú', 'fish'), ('马', 'mǎ', 'horse'),
    ('牛', 'niú', 'cow'), ('羊', 'yáng', 'sheep'), ('狗', 'gǒu', 'dog'), ('猫', 'māo', 'cat'), ('家', 'jiā', 'home'),
    ('门', 'mén', 'door'), ('车', 'chē', 'car'), ('路', 'lù', 'road'), ('桥', 'qiáo', 'bridge'), ('船', 'chuán', 'boat'),
    ('书', 'shū', 'book'), ('笔', 'bǐ', 'pen'), ('纸', 'zhǐ', 'paper'), ('茶', 'chá', 'tea'), ('饭', 'fàn', 'meal'),
    ('米', 'mǐ', 'rice'), ('面', 'miàn', 'noodle'), ('肉', 'ròu', 'meat'), ('菜', 'cài', 'dish'), ('果', 'guǒ', 'fruit'),
    ('手', 'shǒu', 'hand'), ('足', 'zú', 'foot'), ('头', 'tóu', 'head'), ('心', 'xīn', 'heart'), ('口', 'kǒu', 'mouth'),
    ('耳', 'ěr', 'ear'), ('目', 'mù', 'eye'), ('红', 'hóng', 'red'), ('白', 'bái', 'white'), ('黑', 'hēi', 'black'),
    ('黄', 'huáng', 'yellow'), ('青', 'qīng', 'green'), ('新', 'xīn', 'new'), ('旧', 'jiù', 'old'), ('长', 'cháng', 'long'),
    ('短', 'duǎn', 'short'), ('高', 'gāo', 'tall'), ('快', 'kuài', 'fast'), ('慢', 'màn', 'slow'), ('春', 'chūn', 'spring'),
]

HEAD = ['ID', 'Hanzi', 'Pinyin', 'English']
HEAD_G = ['Pattern', 'English', 'Example', 'HSK', 'Family', 'Title EN', 'Title FR', 'Definition EN', 'Definition FR', 'Use EN', 'Use FR', 'Register', 'Sentences']
FAMILIES = ['Emphasis', 'Time', 'Comparison', 'Result', 'Negation']
REGISTERS = ['neutral', 'spoken', 'formal']


def solid(rgb=None, theme=None, tint=0.0):
    return PatternFill('solid', fgColor=Color(rgb='FF' + rgb) if rgb else Color(theme=theme, tint=tint))


FILLS4 = [solid('C5E0B4'), solid('EEA6A6'), solid('FDF95F'), None]
FILLS5 = [solid('A9D18E'), solid('FFFF00'), solid('FF0000'), solid(theme=4, tint=0.4), None, None]


def pair(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + ' ' + b[2])


def make(path, hsk4=570, hsk5=1200, grammar=40):
    rnd = random.Random(20261126)
    pairs = [(a, b) for a in CHARS for b in CHARS if a is not b]
    rnd.shuffle(pairs)
    if hsk4 + hsk5 > len(pairs):
        raise ValueError('not enough distinct pairs: %d' % len(pairs))
    wb = Workbook()
    ws = wb.active
    ws.title = 'HSK四级'
    ws.append(HEAD)
    first = {}
    for i in range(1, hsk4 + 1):
        h, p, e = pair(*pairs[i - 1])
        ws.append([i, h, p, e])
        first.setdefault('HSK四级', h)
        f = FILLS4[(i - 1) % len(FILLS4)]
        if f:
            for col in (1, 2):
                ws.cell(row=i + 1, column=col).fill = f
    w5 = wb.create_sheet('HSK五级')
    w5.append(HEAD)
    for i in range(1, hsk5 + 1):
        h, p, e = pair(*pairs[hsk4 + i - 1])
        w5.append([i, h, p, e])
        first.setdefault('HSK五级', h)
        f = FILLS5[(i - 1) % len(FILLS5)]
        if f:
            for col in range(1, 5):
                w5.cell(row=i + 1, column=col).fill = f
    g = wb.create_sheet('Grammar')
    g.append(HEAD_G)
    for i in range(grammar):
        a, b = pairs[hsk4 + hsk5 + i] if hsk4 + hsk5 + i < len(pairs) else pairs[i]
        pa, pb = pair(a, b), pair(b, a)
        sents = ['%s好。 | Sentence %d-%d in French. | Sentence %d-%d in English.' % (pa[0], i, k, i, k) for k in range(1, 2 + i % 3)]
        g.append([
            '%s + verb' % pa[0], 'pattern %d' % i, '我%s。' % pb[0], str(1 + i % 6), FAMILIES[i % len(FAMILIES)],
            'Title %d' % i, 'Titre %d' % i, 'Definition %d in English.' % i, 'Définition %d en français.' % i,
            'Use %d\nSecond line' % i, 'Usage %d\nDeuxième ligne' % i, REGISTERS[i % len(REGISTERS)], '\n'.join(sents),
        ])
    wb.save(path)
    return first


if __name__ == '__main__':
    make(sys.argv[1] if len(sys.argv) > 1 else 'big.xlsx')
