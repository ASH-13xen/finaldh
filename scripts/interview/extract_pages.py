"""Stage 1 of the interview-transcript pipeline: PDF -> one JSON file of page texts per year.

pdf-parse (used elsewhere in the backend) gives up on the 2020 compilation ("Bad encoding in flate
stream"), while PyMuPDF reads every page of all five, so this one stage is Python.

  pip install pymupdf
  python scripts/interview/extract_pages.py "C:/Users/<you>/Downloads/2024 PT transcripts.pdf" ...

The year is read from the file name. Output: data/interview/pages/<year>.json =
  { "year": 2024, "source": "<file name>", "pages": [{ "page": 1, "text": "...", "imageOnly": false }] }
Pages with almost no text but with images (the scanned pages in 2020) are flagged imageOnly so the
Gemini stage can read them as images instead.
"""
import json
import os
import re
import sys

import fitz  # PyMuPDF

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "interview", "pages")


def main(paths):
    os.makedirs(OUT_DIR, exist_ok=True)
    for path in paths:
        name = os.path.basename(path)
        m = re.search(r"(20\d\d)", name)
        if not m:
            print(f"skip {name}: no year in the file name")
            continue
        year = int(m.group(1))
        doc = fitz.open(path)
        pages = []
        for i, page in enumerate(doc):
            text = page.get_text()
            image_only = len(text.strip()) < 30 and len(page.get_images()) > 0
            pages.append({"page": i + 1, "text": text, "imageOnly": image_only})
        out = os.path.join(OUT_DIR, f"{year}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"year": year, "source": name, "pages": pages}, f, ensure_ascii=False)
        flagged = sum(1 for p in pages if p["imageOnly"])
        print(f"{year}: {len(pages)} pages ({flagged} image-only) -> {os.path.normpath(out)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
