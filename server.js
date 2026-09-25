const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

function parseYouTubeDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function estimateArticleMinutes(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.min(12, Math.ceil(words / 180)));
}

function createDemoResult(topic, durationMinutes) {
  const normalizedTopic = topic || 'ce sujet';
  const safeTopic = normalizedTopic.replace(/\s+/g, ' ');
  const videoTitle = `Connaître ${safeTopic} en quelques minutes`;
  const articleTitle = `${safeTopic} : ce que l’actualité et l’analyse nous apprennent`;
  const opinionTitle = `${safeTopic} : une lecture critique pour mieux comprendre le débat`;

  const video = {
    type: 'video',
    title: videoTitle,
    source: 'YouTube',
    durationMinutes: Math.min(4, Math.max(2, Math.ceil(durationMinutes * 0.4))),
    url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(safeTopic),
    embedUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ',
    reason: 'Une introduction courte et claire pour poser les idées clés.'
  };

  const articleJournalism = {
    type: 'journalism',
    title: articleTitle,
    source: 'Le Monde',
    durationMinutes: Math.max(2, Math.min(6, Math.ceil(durationMinutes * 0.45))),
    url: 'https://www.lemonde.fr/recherche/?search_keywords=' + encodeURIComponent(safeTopic),
    reason: 'Un angle journalistique pour relier le sujet à l’actualité.'
  };

  const articleOpinion = {
    type: 'opinion',
    title: opinionTitle,
    source: 'The Guardian',
    durationMinutes: Math.max(1, Math.min(5, Math.ceil(durationMinutes * 0.35))),
    url: 'https://www.theguardian.com/search?q=' + encodeURIComponent(safeTopic),
    reason: 'Un point de vue plus critique pour élargir la réflexion.'
  };

  const resources = [video, articleJournalism, articleOpinion];
  const total = resources.reduce((sum, item) => sum + item.durationMinutes, 0);

  return {
    topic: safeTopic,
    requestedMinutes: Number(durationMinutes) || 10,
    estimatedMinutes: total,
    resources
  };
}

async function searchYouTube(topic, durationMinutes, language) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const query = [topic, language, 'français'].filter(Boolean).join(' ');
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&relevanceLanguage=${encodeURIComponent(language || 'fr')}&maxResults=5&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) return [];

  const data = await res.json();
  const videoIds = (data.items || []).map(item => item.id.videoId).filter(Boolean);
  if (!videoIds.length) return [];

  const detailRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(videoIds.join(','))}&key=${encodeURIComponent(apiKey)}`);
  if (!detailRes.ok) return [];

  const detailData = await detailRes.json();
  return (detailData.items || []).map(item => {
    const durationSeconds = parseYouTubeDuration(item.contentDetails?.duration || 'PT0S');
    const mins = Math.max(1, Math.ceil(durationSeconds / 60));
    return {
      type: 'video',
      title: item.snippet?.title || 'Vidéo YouTube',
      source: item.snippet?.channelTitle || 'YouTube',
      durationMinutes: mins,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      embedUrl: `https://www.youtube.com/embed/${item.id}`,
      reason: 'Vidéo sélectionnée à partir des métadonnées YouTube et de la demande de l’utilisateur.',
      language: item.snippet?.defaultAudioLanguage || language || 'fr'
    };
  }).filter(item => item.durationMinutes <= Math.max(1, Number(durationMinutes) || 10));
}

async function searchPerplexity(topic, durationMinutes, language) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `Tu es un assistant de recherche éditoriale pour Erudix. Cherche uniquement des articles journalistiques, tribunes, analyses et articles d'opinion de médias identifiables et accessibles. Exclue Wikipédia, résultats Google, sites non identifiables et contenus douteux. Le sujet est: "${topic}". Langue préférée: ${language || 'fr'}. Temps disponible: ${durationMinutes} minutes. Retourne uniquement un JSON valide avec une clé "resources" contenant 3 objets. Chaque objet doit avoir: title, source, url, minutes, type, reason. type doit être "journalism" ou "opinion". Ne fabrique aucun titre, source ou URL. Ne réponds pas en texte libre. Les url doivent être réelles et vérifiables.`;

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Tu réponds uniquement en JSON valide sans texte avant ni après.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1200
    })
  });

  if (!res.ok) return [];
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.resources) ? parsed.resources.map(item => ({
      type: item.type === 'opinion' ? 'opinion' : 'journalism',
      title: item.title,
      source: item.source,
      durationMinutes: Number(item.minutes) || estimateArticleMinutes(item.title || ''),
      url: item.url,
      reason: item.reason || 'Article sélectionné pour son intérêt éditorial.'
    })) : [];
  } catch (error) {
    return [];
  }
}

async function buildSession(payload) {
  const topic = String(payload.topic || '').trim();
  const durationMinutes = Number(payload.durationMinutes || 10);
  const language = String(payload.language || 'fr');
  const interests = Array.isArray(payload.interests) ? payload.interests : [];
  const regions = Array.isArray(payload.regions) ? payload.regions : [];

  if (!topic) {
    return { error: 'topic required' };
  }

  const youtubeResults = await searchYouTube([topic, ...interests, ...regions].join(' '), durationMinutes, language);
  const articleResults = await searchPerplexity(topic, durationMinutes, language);

  const merged = [...youtubeResults, ...articleResults];
  const selected = [];
  let total = 0;

  for (const item of merged) {
    const minutes = Number(item.durationMinutes || 3);
    if (total + minutes <= durationMinutes) {
      selected.push(item);
      total += minutes;
    }
  }

  if (!selected.length) {
    const demo = createDemoResult(topic, durationMinutes);
    return {
      topic: demo.topic,
      requestedMinutes: demo.requestedMinutes,
      estimatedMinutes: demo.estimatedMinutes,
      resources: demo.resources
    };
  }

  return {
    topic,
    requestedMinutes: durationMinutes,
    estimatedMinutes: total,
    resources: selected
  };
}

app.post('/api/generate-session', async (req, res) => {
  const payload = req.body || {};
  const session = await buildSession(payload);
  if (session.error) return res.status(400).json(session);
  return res.json(session);
});

app.use(express.static(path.join(__dirname, '.')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Erudix V4 backend running on http://localhost:${PORT}`);
});
