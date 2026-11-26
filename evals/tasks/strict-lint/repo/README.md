# sales-report

Reads a CSV export of sales and summarizes it by region: `summarize(csvText)` gives each region's
total and count, largest total first, and `renderReport` writes it as text.

The CSV has a header line `date,region,amount,note`. Fields may be quoted with `"`, and a quoted
field may hold commas and doubled quotes (`""`). Blank lines are skipped. A line with the wrong
number of fields, or an amount that is not a number, throws `CsvError` with its line number.
