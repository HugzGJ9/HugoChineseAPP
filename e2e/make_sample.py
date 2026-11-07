"""Writes a small synthetic workbook for the e2e checks: python e2e/make_sample.py OUT.xlsx
Common HSK 1 words only, made up for tests. No personal data. Needs openpyxl. Never commit the output."""
import sys
from openpyxl import Workbook
from openpyxl.styles import PatternFill

WORDS = [
    ('你好', 'nǐ hǎo', 'hello'), ('谢谢', 'xièxie', 'thank you'), ('再见', 'zàijiàn', 'goodbye'),
    ('请', 'qǐng', 'please'), ('对不起', 'duìbuqǐ', 'sorry'), ('没关系', 'méi guānxi', 'it does not matter'),
    ('我', 'wǒ', 'I, me'), ('你', 'nǐ', 'you'), ('他', 'tā', 'he'), ('她', 'tā', 'she'),
    ('们', 'men', 'plural marker'), ('是', 'shì', 'to be'), ('不', 'bù', 'not'), ('有', 'yǒu', 'to have'),
    ('好', 'hǎo', 'good'), ('大', 'dà', 'big'), ('小', 'xiǎo', 'small'), ('多', 'duō', 'many'),
    ('少', 'shǎo', 'few'), ('人', 'rén', 'person'), ('水', 'shuǐ', 'water'), ('茶', 'chá', 'tea'),
    ('米饭', 'mǐfàn', 'cooked rice'), ('吃', 'chī', 'to eat'), ('喝', 'hē', 'to drink'),
    ('看', 'kàn', 'to look'), ('说', 'shuō', 'to speak'), ('去', 'qù', 'to go'), ('来', 'lái', 'to come'),
    ('今天', 'jīntiān', 'today'), ('明天', 'míngtiān', 'tomorrow'), ('学校', 'xuéxiào', 'school'),
    ('老师', 'lǎoshī', 'teacher'), ('朋友', 'péngyou', 'friend'), ('中国', 'Zhōngguó', 'China'),
]
GREEN = PatternFill('solid', fgColor='C5E0B4')

wb = Workbook()
ws = wb.active
ws.title = 'HSK1'
ws.append(['ID', 'Hanzi', 'Pinyin', 'English'])
for i, (h, p, e) in enumerate(WORDS, 1):
    ws.append([i, h, p, e])
# Two rows marked green = already studied.
for row in (2, 3):
    for cell in ws[row]:
        cell.fill = GREEN

g = wb.create_sheet('Grammar')
g.append(['Pattern', 'English', 'Example'])
g.append(['不 + verb', 'negation', '我不吃肉。'])
g.append(['是……的', 'emphasis on how or when', '我是昨天来的。'])
g.append(['有 + noun', 'to have', '我有一个朋友。'])

wb.save(sys.argv[1] if len(sys.argv) > 1 else 'sample.xlsx')
