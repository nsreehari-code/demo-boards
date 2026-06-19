export const MOCK_DB = {
  quotes: {
    quoteResponse: {
      result: [
        { symbol: 'AAPL', shortName: 'Apple Inc.', regularMarketPrice: 198.15, regularMarketChange: 2.15, regularMarketChangePercent: 1.10 },
        { symbol: 'MSFT', shortName: 'Microsoft Corp.', regularMarketPrice: 415.32, regularMarketChange: -1.23, regularMarketChangePercent: -0.30 },
        { symbol: 'GOOGL', shortName: 'Alphabet Inc.', regularMarketPrice: 174.89, regularMarketChange: 0.89, regularMarketChangePercent: 0.51 },
        { symbol: 'TSLA', shortName: 'Tesla Inc.', regularMarketPrice: 247.12, regularMarketChange: 5.43, regularMarketChangePercent: 2.25 }
      ],
      error: null
    }
  },

  // --- Profile investigator probe fixtures (S1) -------------------------------
  // Deterministic, planted background data for the 'profile' journeys board,
  // keyed for the seed person "Alex Rivera". These are intentionally richer than
  // the test strictly needs (several candidate identities, multiple items per
  // facet) so the domain pack has real content to narrow and filter. A facet card
  // wires to one of these via source_def: { "mock": "<key>" }.
  profile_alex_rivera_identities: {
    query: 'Alex Rivera',
    note: 'Several distinct people share this name; confirm which one this profile is about.',
    candidates: [
      { id: 'ar-eng', name: 'Alex Rivera', headline: 'Staff Software Engineer · cloud infrastructure', location: 'Seattle, WA', confidence: 0.71 },
      { id: 'ar-design', name: 'Alex Rivera', headline: 'Product Designer', location: 'Austin, TX', confidence: 0.16 },
      { id: 'ar-athlete', name: 'Alex Rivera', headline: 'Professional cyclist', location: 'Bogota, CO', confidence: 0.09 },
      { id: 'ar-author', name: 'Alex Rivera', headline: 'Author & journalist', location: 'New York, NY', confidence: 0.04 }
    ]
  },
  profile_alex_rivera_linkedin: {
    identity_id: 'ar-eng',
    name: 'Alex Rivera',
    current_role: 'Staff Software Engineer',
    company: 'Northwind Cloud',
    headline: 'Distributed systems · platform reliability',
    experience: [
      { title: 'Staff Software Engineer', company: 'Northwind Cloud', start: '2021', end: 'present' },
      { title: 'Senior Software Engineer', company: 'Contoso', start: '2017', end: '2021' },
      { title: 'Software Engineer', company: 'Fabrikam', start: '2014', end: '2017' }
    ],
    education: [{ school: 'University of Washington', degree: 'B.S. Computer Science', year: '2014' }],
    skills: ['distributed systems', 'Go', 'Kubernetes', 'observability']
  },
  profile_alex_rivera_social: {
    identity_id: 'ar-eng',
    handles: [
      { platform: 'GitHub', handle: 'arivera-dev', url: 'https://github.com/arivera-dev', followers: 1280 },
      { platform: 'X', handle: '@arivera_sys', url: 'https://x.com/arivera_sys', followers: 4400 },
      { platform: 'Mastodon', handle: '@alex@hachyderm.io', url: 'https://hachyderm.io/@alex', followers: 610 },
      { platform: 'LinkedIn', handle: 'in/alex-rivera-eng', url: 'https://linkedin.com/in/alex-rivera-eng' }
    ]
  },
  profile_alex_rivera_publications: {
    identity_id: 'ar-eng',
    patents: [
      { id: 'US10,512,003', title: 'Adaptive load shedding for distributed queues', year: 2020 }
    ],
    papers: [
      { title: 'Tail-latency-aware autoscaling for stateful services', venue: 'SREcon', year: 2022 },
      { title: 'Backpressure patterns for streaming pipelines', venue: 'Whitepaper', year: 2019 }
    ]
  },
  profile_alex_rivera_news: {
    identity_id: 'ar-eng',
    mentions: [
      { source: 'TechDaily', title: 'Northwind Cloud cuts outage rate 40% after reliability overhaul', date: '2024-03-11', sentiment: 'positive' },
      { source: 'Conference Wire', title: 'SREcon 2022 speaker lineup announced', date: '2022-09-01', sentiment: 'neutral' },
      { source: 'Dev Weekly', title: 'Open-source load-shedding library crosses 5k stars', date: '2023-06-20', sentiment: 'positive' }
    ]
  }
};
