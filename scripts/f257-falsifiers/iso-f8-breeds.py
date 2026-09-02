import json
G='/Users/lang/workspace/github-lab/clowder-ai-f257-gate'
cat=json.load(open(f'{G}/.cat-cafe/cat-catalog.json')); tpl=json.load(open(f'{G}/cat-template.json'))
print('catalog keys:', list(cat.keys()))
breeds=cat.setdefault('breeds', [])
have={b.get('id') for b in breeds}
print('breeds before:', sorted(have))
for b in tpl['breeds']:
    if b.get('id') in ('ragdoll','moonshot') and b.get('id') not in have:
        breeds.append(json.loads(json.dumps(b)))
cat['roster'].setdefault('opus',   {"family":"ragdoll","roles":["architect"],"lead":True,"available":True})
cat['roster'].setdefault('sonnet', {"family":"ragdoll","roles":["architect"],"lead":False,"available":True})
cat['roster'].setdefault('kimi',   {"family":"moonshot","roles":["research"],"lead":True,"available":True})
json.dump(cat, open(f'{G}/.cat-cafe/cat-catalog.json','w'), ensure_ascii=False, indent=2)
print('breeds after:', sorted(b.get('id') for b in cat['breeds']), 'roster:', list(cat['roster'].keys()))
