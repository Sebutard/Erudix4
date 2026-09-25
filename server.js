const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));

function parseYouTubeDuration(iso) {
  const match = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0;
}
function estimateArticleMinutes(text) {
  return Math.max(1, Math.min(12, Math.ceil(String(text || '').split(/\s+/).filter(Boolean).length / 180)));
}

function selectResources(candidates, budget, topic) {
  const limit = Math.max(1, Number(budget) || 10);
  const usable = (candidates || []).filter(item => item && item.url && Number(item.durationMinutes) > 0 && Number(item.durationMinutes) <= limit);
  const videos = usable.filter(item => item.type === 'video').sort((a, b) => a.durationMinutes - b.durationMinutes);
  const articles = usable.filter(item => item.type !== 'video').sort((a, b) => a.durationMinutes - b.durationMinutes);
  const selected = [];
  let total = 0;

  const add = item => {
    if (!item || selected.includes(item)) return false;
    if (total + Number(item.durationMinutes) > limit) return false;
    selected.push(item);
    total += Number(item.durationMinutes);
    return true;
  };

  // Prefer a balanced mix: at least one video and at least one article.
  for (const item of videos.slice(0, 3)) add(item);
  for (const item of articles.slice(0, 3)) add(item);

  // Fill remaining budget with other relevant items.
  for (const item of usable.sort((a, b) => a.durationMinutes - b.durationMinutes)) {
    if (selected.length >= 4) break;
    add(item);
  }

  // If we still don't have an article / video, add a fallback.
  if (!selected.some(item => item.type === 'video')) {
    const fallback = videos[0] || usable[0];
    if (fallback) add(fallback);
  }
  if (!selected.some(item => item.type !== 'video')) {
    const fallback = articles[0] || usable.find(item => item.type !== 'video');
    if (fallback) add(fallback);
  }

  return { topic, requestedMinutes: limit, estimatedMinutes: total, resources: selected };
}

function demoResources(topic, budget) {
  const subject = String(topic || 'ce sujet').replace(/\s+/g, ' ');
  const items = [
    { type: 'video', title: `Vidéo d’introduction sur « ${subject} »`, source: 'YouTube', durationMinutes: 3, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', embedUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ', reason: 'Vidéo de démonstration en attendant la recherche YouTube réelle.' },
    { type: 'journalism', title: `Les points essentiels pour comprendre ${subject}`, source: 'Article de démonstration', durationMinutes: 3, url: `https://www.google.com/search?q=${encodeURIComponent(subject)}`, reason: 'Article journalistique de démonstration.' },
    { type: 'opinion', title: `${subject} : analyse et points de vue`, source: 'Article de démonstration', durationMinutes: 3, url: `https://www.google.com/search?q=${encodeURIComponent(subject)}`, reason: 'Article d’opinion de démonstration.' },
    { type: 'video', title: `Vidéo complémentaire sur « ${subject} »`, source: 'YouTube', durationMinutes: 2, url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', embedUrl: 'https://www.youtube.com/embed/M7lc1UVf-VE', reason: 'Deuxième ressource vidéo pour mieux remplir le budget.' }
  ];
  return selectResources(items, budget, subject);
}

async function searchYouTube(topic, budget, language) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return [];
  const query = [topic, language, 'français'].filter(Boolean).join(' ');
  const search = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true&relevanceLanguage=${encodeURIComponent(language || 'fr')}&maxResults=10&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`);
  if (!search.ok) return [];
  const result = await search.json();
  const ids = (result.items || []).map(item => item.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(key)}`);
  if (!details.ok) return [];
  const data = await details.json();
  return (data.items || []).map(item => {
    const seconds = parseYouTubeDuration(item.contentDetails?.duration);
    return {
      type: 'video',
      title: item.snippet?.title || 'Vidéo YouTube',
      source: item.snippet?.channelTitle || 'YouTube',
      durationMinutes: Math.max(1, Math.ceil(seconds / 60)),
      url: `https://www.youtube.com/watch?v=${item.id}`,
      embedUrl: `https://www.youtube.com/embed/${item.id}`,
      reason: 'Vidéo sélectionnée directement depuis YouTube selon le sujet.',
      language: item.snippet?.defaultAudioLanguage || language || 'fr'
    };
  }).filter(item => item.durationMinutes <= Math.max(1, Number(budget) || 10));
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function searchPerplexity(topic, budget, language) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return [];
  const prompt = `Recherche 5 articles réels sur « ${topic} », en ${language || 'fr'}, pour un temps total de ${budget} minutes. Retourne uniquement JSON: {"resources":[{"title":"...","source":"...","url":"...","minutes":2,"type":"journalism|opinion","reason":"..."}]}. Inclusion obligatoire d’au moins 2 articles, dont au moins 1 journalism et 1 opinion. Utilise des URLs existantes et vérifiables.`;
  const response = await fetch('https://api.perplexity.ai/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'sonar', messages: [{ role: 'system', content: 'Réponds uniquement en JSON valide.' }, { role: 'user', content: prompt }], max_tokens: 1800 }) });
  if (!response.ok) return [];
  const parsed = extractJson((await response.json())?.choices?.[0]?.message?.content || '');
  return (parsed?.resources || []).filter(item => item.title && item.url).map(item => ({
    type: item.type === 'opinion' ? 'opinion' : 'journalism',
    title: item.title,
    source: item.source || 'Média',
    durationMinutes: Number(item.minutes) || estimateArticleMinutes(item.title),
    url: item.url,
    reason: item.reason || 'Article sélectionné pour sa pertinence.'
  }));
}

async function buildSession(payload) {
  const topic = String(payload.topic || '').trim();
  const budget = Number(payload.durationMinutes || 10);
  if (!topic) return { error: 'topic required' };
  const language = String(payload.language || 'fr');
  const query = [topic, ...(Array.isArray(payload.interests) ? payload.interests : []), ...(Array.isArray(payload.regions) ? payload.regions : [])].join(' ');
  const [videos, articles] = await Promise.all([searchYouTube(query, budget, language), searchPerplexity(topic, budget, language)]);
  const result = selectResources([...videos, ...articles], budget, topic);
  return result.resources.length ? result : demoResources(topic, budget);
}

app.post('/api/generate-session', async (req, res) => {
  try {
    const result = await buildSession(req.body || {});
    return result.error ? res.status(400).json(result) : res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(502).json({ error: 'resource search failed' });
  }
});

app.use(express.static(path.join(__dirname, '.')));
app.get('*', (req, res) => req.path.startsWith('/api/') ? res.status(404).json({ error: 'Not found' }) : res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`Erudix V5 backend running on http://localhost:${PORT}`));
