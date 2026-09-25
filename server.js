const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

function parseYouTubeDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function estimateArticleMinutes(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.min(12, Math.ceil(words / 180)));
}

function createDemoResult(topic, durationMinutes) {
  const safeTopic = String(topic || 'ce sujet').replace(/\s+/g, ' ');
  const videoId = 'aqz-KE-bpKQ';
  const video = {
    type: 'video',
    title: `Vidéo YouTube de démonstration pour « ${safeTopic} »`,
    source: 'YouTube',
    durationMinutes: Math.min(4, Math.max(2, Math.ceil(durationMinutes * 0.4))),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    reason: 'Mode démonstration : en production, cette carte sera remplacée par une vidéo trouvée par l’API YouTube.'
  };
  const resources = [video];
  const total = video.durationMinutes;
  return { topic: safeTopic, requestedMinutes: Number(durationMinutes) || 10, estimatedMinutes: total, resources };
}

async function searchYouTube(topic, durationMinutes, language) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  const query = [topic, language, 'français'].filter(Boolean).join(' ');
  const search = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&relevanceLanguage=${encodeURIComponent(language || 'fr')}&maxResults=10&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`);
  if (!search.ok) return [];
  const searchData = await search.json();
  const ids = (searchData.items || []).map(item => item.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const details = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(apiKey)}`);
  if (!details.ok) return [];
  const detailData = await details.json();
  return (detailData.items || []).map(item => {
    const seconds = parseYouTubeDuration(item.contentDetails?.duration || 'PT0S');
    return {
      type: 'video',
      title: item.snippet?.title || 'Vidéo YouTube',
      source: item.snippet?.channelTitle || 'YouTube',
      durationMinutes: Math.max(1, Math.ceil(seconds / 60)),
      durationSeconds: seconds,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      embedUrl: `https://www.youtube.com/embed/${item.id}`,
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url,
      reason: 'Vidéo sélectionnée par l’API YouTube selon le sujet et les métadonnées disponibles.',
      language: item.snippet?.defaultAudioLanguage || item.snippet?.defaultLanguage || language || 'fr'
    };
  }).filter(item => item.durationMinutes <= Math.max(1, Number(durationMinutes) || 10));
}

async function searchPerplexity(topic, durationMinutes, language) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];
  const prompt = `Tu es un assistant de recherche éditoriale pour Erudix. Cherche uniquement des articles journalistiques, tribunes, analyses et articles d'opinion de médias identifiables et accessibles. Exclue Wikipédia, résultats Google, sites non identifiables et contenus douteux. Sujet: "${topic}". Langue: ${language || 'fr'}. Temps: ${durationMinutes} minutes. Retourne uniquement un JSON valide avec une clé resources contenant 3 objets: title, source, url, minutes, type, reason. type vaut journalism ou opinion. Ne fabrique aucun titre, média ou URL.`;
  const response = await fetch('https://api.perplexity.ai/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: 'sonar', messages: [{ role: 'system', content: 'Réponds uniquement en JSON valide.' }, { role: 'user', content: prompt }], max_tokens: 1200 }) });
  if (!response.ok) return [];
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.resources) ? parsed.resources.filter(item => item.url && item.title).map(item => ({ type: item.type === 'opinion' ? 'opinion' : 'journalism', title: item.title, source: item.source || 'Média', durationMinutes: Number(item.minutes) || estimateArticleMinutes(item.title), url: item.url, reason: item.reason || 'Article sélectionné pour sa pertinence éditoriale.' })) : [];
  } catch { return []; }
}

async function buildSession(payload) {
  const topic = String(payload.topic || '').trim();
  const durationMinutes = Number(payload.durationMinutes || 10);
  if (!topic) return { error: 'topic required' };
  const interests = Array.isArray(payload.interests) ? payload.interests : [];
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const language = String(payload.language || 'fr');
  const videos = await searchYouTube([topic, ...interests, ...regions].join(' '), durationMinutes, language);
  const articles = await searchPerplexity(topic, durationMinutes, language);
  const selected = [];
  let total = 0;
  for (const item of [...videos, ...articles]) {
    if (total + item.durationMinutes <= durationMinutes) { selected.push(item); total += item.durationMinutes; }
  }
  if (!selected.length) return createDemoResult(topic, durationMinutes);
  return { topic, requestedMinutes: durationMinutes, estimatedMinutes: total, resources: selected };
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
app.listen(PORT, () => console.log(`Erudix V4 backend running on http://localhost:${PORT}`));
