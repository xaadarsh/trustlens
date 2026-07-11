# TrustLens Chrome Web Store Draft

## Short description
Pattern-based Amazon review confidence checks, with optional BYO-key AI deep dives.

## Primary hook
Fakespot is dead. Here's the replacement.

## Long description
TrustLens adds a lightweight review-confidence panel to supported Amazon product pages. It scans visible review patterns such as verified-purchase mix, rating concentration, review timing, review count relative to listing age, and repeated language.

TrustLens does not label reviews, reviewers, sellers, or products as fake. It shows confidence signals based on the public data visible in your browser, then explains what may be worth inspecting before you buy.

Pro users can run an optional deep dive with their own Gemini or OpenAI API key. Your key is stored locally in Chrome extension storage and is used only when you request a deep dive.

## Permissions story
TrustLens uses Chrome storage for settings, BYO API keys, local dev Pro state, and cached license checks. Host permissions are limited to supported Amazon locales. It does not request broad host permissions or `<all_urls>`.

## Privacy notes
TrustLens does not collect browsing history. Analysis runs locally against the visible Amazon DOM. Optional deep dives send the current product title, public review metadata, and visible review excerpts to the provider selected by the user.
