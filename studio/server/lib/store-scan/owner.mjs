/**
 * What only the owner can state or do for a release (docs/store-rules.md): laws that ask for a person's word, by the
 * countries the app ships to and what it does, each from the day it applies; the store-console forms no API fills; and
 * the dated changes coming up. Kept current by the weekly rules watch. A statement is asked on the release card and
 * kept per app for a year, or until its revision changes.
 */

export const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']

/**
 * `where`: 'ALL', 'EU', or country codes; `features`: the app does at least one of these (none: every app); `stores`:
 * only for these; `from`: the day it applies (it is listed as coming up before that).
 */
export const STATEMENTS = [
  {
    id: 'privacy-policy', revision: 1, where: 'ALL', from: '2018-05-25',
    title: 'The privacy policy is true and live',
    says: "The privacy policy at the listing's address says what the app collects, why, who else gets it, how long it is kept and how to have it deleted, and it matches the app as it is now.",
    source: 'https://developer.apple.com/app-store/review/guidelines/#5.1.1',
  },
  {
    id: 'eu-personal-data', revision: 1, where: 'EU', features: ['personal_data', 'accounts'], from: '2018-05-25',
    title: 'Personal data is handled as the GDPR asks',
    says: 'Each use of personal data has a lawful basis, people can get a copy of theirs and have it deleted, and any processor (hosting, analytics, email) has a data processing agreement.',
    source: 'https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations_en',
  },
  {
    id: 'eu-trader', revision: 1, where: 'EU', from: '2025-02-17',
    title: 'Trader status is set for the EU',
    says: 'Your trader status (trader or not, with address and contact for a trader) is set in App Store Connect and Play Console, as the Digital Services Act asks; without it the app is not shown in the EU.',
    source: 'https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements',
  },
  {
    id: 'eu-security-reporting', revision: 1, where: 'EU', from: '2026-09-11',
    title: 'Security holes are reported in time (Cyber Resilience Act)',
    says: 'A named person watches for security holes in the app, and reports one that is being exploited to the EU (ENISA) within 24 hours of knowing, with a full notice within 72 hours.',
    source: 'https://digital-strategy.ec.europa.eu/en/policies/cra-reporting',
  },
  {
    id: 'eu-ai-transparency', revision: 1, where: 'EU', features: ['ai'], from: '2026-08-02',
    title: 'People know when they deal with AI (AI Act, Article 50)',
    says: 'The app tells people when they are talking to an AI, and marks images, sound and video the AI made as AI-made.',
    source: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  },
  {
    id: 'eu-accessibility', revision: 1, where: 'EU', features: ['commerce', 'banking', 'booking', 'ebooks'], from: '2025-06-28',
    title: 'Shopping, banking, booking and e-book parts are accessible (European Accessibility Act)',
    says: 'Those parts of the app work with screen readers and larger text, and an accessibility statement is published.',
    source: 'https://commission.europa.eu/strategy-and-policy/policies/justice-and-fundamental-rights/disability/union-equality-strategy-rights-persons-disabilities-2021-2030/european-accessibility-act_en',
  },
  {
    id: 'us-children', revision: 1, where: ['US'], features: ['kids'], from: '2025-06-23',
    title: "Children's data is handled as COPPA asks",
    says: 'No personal data from children under 13 without a parent\'s verifiable consent, no ads or analytics that track them, and a written data retention and security plan.',
    source: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa',
  },
  {
    id: 'us-ca-age-signal', revision: 1, where: ['US'], from: '2027-01-01',
    title: "The app reads the phone's age signal where California asks (Digital Age Assurance Act)",
    says: "The app asks the phone or store for the user's age range where the law asks, and treats a minor as one.",
    source: 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260AB1043',
  },
]

/** The store-console forms only the owner can fill, per store, each in words. */
export const CONSOLE = {
  play: [
    { id: 'play-data-safety', says: 'Play Data safety answers match what the app collects and shares' },
    { id: 'play-content-rating', says: 'Play content rating questionnaire is current' },
    { id: 'play-audience-ads', says: 'Play target audience and "contains ads" answers are current' },
    { id: 'play-identity', says: 'Your developer identity is verified in Play Console' },
  ],
  appstore: [
    { id: 'apple-privacy', says: 'App Store privacy answers match what the app collects and shares' },
    { id: 'apple-age-rating', says: 'App Store age rating answers are current' },
    { id: 'apple-agreements', says: 'App Store agreements, tax and banking are signed' },
  ],
}

/** Dated store changes, besides the statements' own dates. */
export const DATES = [
  { id: 'play-target-36', on: '2026-08-31', stores: ['play'], says: 'Play: new apps and updates must target API level 36 (Android 16)', source: 'https://developer.android.com/google/play/requirements/target-sdk' },
  { id: 'apple-sdk-26', on: '2026-04-28', stores: ['appstore'], says: 'App Store: uploads must be built with the iOS 26 SDK (Xcode 26) or later', source: 'https://developer.apple.com/news/upcoming-requirements/' },
]

const inWhere = (where, regions) => (where === 'ALL' ? true : where === 'EU' ? regions.some((r) => EU.includes(r)) : where.some((c) => regions.includes(c)))
const forApp = (s, { regions, features, stores }) => inWhere(s.where, regions) && (!s.features || s.features.some((f) => features.includes(f))) && (!s.stores || s.stores.some((x) => stores.includes(x)))

/**
 * What the owner states for this release: the statements in force that apply and are not already kept (a kept one at
 * the same revision, made under a year ago, stands). Coming up: the statements and dates of the next `days`.
 */
export function ownerPart({ regions, features, stores, today, kept = {}, days = 120 }) {
  const until = new Date(Date.parse(today) + days * 86400_000).toISOString().slice(0, 10)
  const yearAgo = new Date(Date.parse(today) - 365 * 86400_000).toISOString().slice(0, 10)
  const mine = STATEMENTS.filter((s) => forApp(s, { regions, features, stores }))
  const fresh = (s) => kept[s.id] && kept[s.id].revision === s.revision && kept[s.id].on >= yearAgo
  return {
    state: mine.filter((s) => s.from <= today && !fresh(s)),
    standing: mine.filter((s) => s.from <= today && fresh(s)).map((s) => s.id),
    console: stores.flatMap((s) => CONSOLE[s] || []),
    coming: [
      ...mine.filter((s) => s.from > today && s.from <= until).map((s) => ({ on: s.from, says: s.title, source: s.source })),
      ...DATES.filter((d) => d.on > today && d.on <= until && d.stores.some((x) => stores.includes(x))).map((d) => ({ on: d.on, says: d.says, source: d.source })),
    ].sort((a, b) => a.on.localeCompare(b.on)),
  }
}
