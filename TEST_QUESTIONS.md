# Trying the app with 10 PDFs

Make them (all made up, safe to share): `../.venv/bin/python make_test_pdfs.py` → `test_pdfs/`.
Upload all 10 at once (Upload button, or drag them onto the page).

## 1. The chat, before choosing a PDF
| Say | Expect |
|---|---|
| `hi, what's up?` | A friendly hello + your PDFs as buttons |
| `how does this work?` | The step-by-step guide |
| `What is the monthly rent?` | "Which PDF should I look in?" → tap **Maple Court lease** → answers **1,450 euros, p.2** |
| `open the gym terms` | The gym PDF opens on the left, chat moves right |
| `How much is a day pass on the lumen buses?` | Opens the bus guide by itself → **7 euros, p.2** |
| `switch to the router guide` | Switches PDFs |
| `what pdfs do I have?` | Lists them as buttons |

## 2. Questions per PDF (open the PDF first)
| PDF | Question | Answer | Page |
|---|---|---|---|
| Maple Court lease agreement | Are pets allowed? | With written permission | 3 |
| | How much notice to end the lease early? | 60 days | 3 |
| Brightwave employee handbook | How many holiday days do I get? | 26 | 2 |
| | How long is parental leave? | 20 weeks | 2 |
| Nimbus travel insurance policy | How much is the excess? | 100 euros per claim | 3 |
| | What is the limit for lost baggage? | 1,500 euros | 2 |
| Aurora espresso machine manual | How often should I descale? | Every 2 months | 2 |
| | What does a blinking red light mean? | Water tank is empty | 3 |
| Riverside Gym membership terms | How much is the Plus membership? | 59 euros a month | 2 |
| Lumen city bus guide | Which bus goes to the airport? | Line 12 | 3 |
| Orbit Wi-Fi router quick start | What does a blinking amber light mean? | No internet connection | 3 |
| Greenleaf school prospectus | When do applications close? | 15 January | 2 |
| Saffron Kitchen recipe booklet | How long do I bake the salmon? | 12 to 15 minutes | 3 |
| Northwind solar panel warranty | How long is the product warranty? | 15 years | 2 |

## 3. Things it should NOT answer
With the espresso manual open: `What is the capital of France?` → "I couldn't find that in this document."

## 4. On your phone
Tap **Page N** on an answer: the PDF slides up at that page. Try the mic: tap, ask, tap again.
