"""Build a named OFL subset for the site's display copy; never fetch at runtime."""
import hashlib
import json
import pathlib
import sys
from html.parser import HTMLParser
from fontTools import subset
from fontTools.ttLib import TTFont

root = pathlib.Path(__file__).resolve().parent.parent
source = pathlib.Path(sys.argv[1]).resolve()

class DisplayCopy(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.capture, self.feature_data = [], [], False
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('h1', 'h2') or (tag == 'p' and attrs.get('class') == 'handwritten-note'):
            self.capture.append(tag)
        if tag == 'script' and attrs.get('id') == 'feature-data':
            self.feature_data = True
    def handle_endtag(self, tag):
        if self.capture and self.capture[-1] == tag:
            self.capture.pop()
        if tag == 'script':
            self.feature_data = False
    def handle_data(self, text):
        if self.capture:
            self.parts.append(text)
        if self.feature_data:
            for feature in json.loads(text):
                self.parts.extend(page['headline'] for page in feature['pages'])

parser = DisplayCopy()
parser.feed((root / 'index.html').read_text(encoding='utf-8'))
characters = ''.join(sorted(set(''.join(parser.parts) + ''.join(chr(n) for n in range(32, 127)))))
font = TTFont(source)
missing = sorted(set(map(ord, characters)) - set(font.getBestCmap()))
if missing:
    raise ValueError('Missing display glyphs: ' + ''.join(map(chr, missing)))
options = subset.Options()
options.flavor = 'woff2'
options.name_IDs = ['*']
options.name_languages = ['*']
options.notdef_glyph = True
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=characters)
subsetter.subset(font)
# Keep the original OFL notices and give the subset its own family name.
names = {1: 'Knorvia Hand', 2: 'Light', 3: 'KnorviaHand-Light-1.522-subset',
         4: 'Knorvia Hand Light', 6: 'KnorviaHand-Light', 16: 'Knorvia Hand',
         17: 'Light', 18: 'Knorvia Hand Light', 21: 'Knorvia Hand', 22: 'Light'}
for record in font['name'].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.flavor = 'woff2'
destination = root / 'assets/fonts/knorvia-hand.woff2'
font.save(destination)
metadata = dict(family='Knorvia Hand', weight=300, characters=characters,
    glyphs=len(font.getGlyphOrder()), source='LXGW WenKai Light v1.522',
    source_url='https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522',
    source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
    bytes=destination.stat().st_size, sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
(root / 'scripts/handwriting-coverage.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k:metadata[k] for k in ('family','weight','glyphs','bytes','sha256')}))
