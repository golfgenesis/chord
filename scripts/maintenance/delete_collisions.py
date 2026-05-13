import json, os

OUT_DIR = r"C:\Users\black\OneDrive\เดสก์ท็อป\chordtabs"
colls = json.load(open(r"C:\Users\black\chordtabs_scrape\case_collisions.json", "r", encoding="utf-8"))

# Delete one canonical file per collision group (Windows treats them as the same path)
deleted = 0
missing = 0
for g in colls:
    # Use the first variant's fname — Windows will resolve case-insensitively
    fname = g["records"][0]["fname"]
    path = os.path.join(OUT_DIR, fname)
    if os.path.exists(path):
        os.remove(path)
        deleted += 1
    else:
        missing += 1
        print(f"  missing: {path}")

print(f"Deleted: {deleted}")
print(f"Missing: {missing}")
print(f"Total collision groups: {len(colls)}")
