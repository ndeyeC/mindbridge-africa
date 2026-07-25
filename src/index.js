const express = require('express');
const Groq = require('groq-sdk');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Initialisation Firebase ───────────────────────────────────────────────
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();
console.log('✅ Firebase connecté');

// ─── Initialisation Groq ───────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
console.log('✅ Groq connecté');

// ─── Prompt système ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es MindBridge, un assistant psychologique bienveillant spécialisé pour l'Afrique.

TON RÔLE :
- Écouter avec empathie et sans jugement
- Poser des questions douces pour comprendre la situation
- Donner des conseils pratiques adaptés au contexte africain
- Détecter TOUS les niveaux de détresse, même les signaux faibles

NIVEAUX DE DÉTRESSE :

🟢 NIVEAU 1 - Conversation normale :
- Stress, fatigue passagère, questions de vie quotidienne
- Tu écoutes, conseilles, accompagnes
- urgence: false, orientation_psy: false

🟡 NIVEAU 2 - Signaux faibles (orientation recommandée) :
- "je dors plus", "je mange plus", "je me sens seul"
- "personne ne me comprend", "je suis fatigué de tout"
- "ça fait des semaines que je vais mal"
- "j'ai perdu goût à tout", "je pleure tout le temps"
- Tu continues d'écouter MAIS tu recommandes un suivi professionnel
- urgence: false, orientation_psy: TRUE

🔴 NIVEAU 3 - Urgence critique :
- Toute mention de suicide, automutilation, mort
- "je veux plus vivre", "je veux mourir"
- "je vais me faire du mal", "la vie ne vaut rien"
- Désespoir total et explicite
- urgence: TRUE, orientation_psy: true

RÈGLES IMPORTANTES :
- Réponds TOUJOURS en français ou dans la langue de l'utilisateur
- Sois chaleureux, humain, jamais robotique
- Ne pose qu'UNE seule question à la fois
- Maximum 3-4 phrases courtes
- Ne jamais minimiser la souffrance du patient
- Si tu détectes niveau 2 ou 3 → mentionne discrètement qu'un professionnel peut aider
- Adapte ton langage au contexte africain (famille, communauté, foi...)

EXEMPLES DE RÉPONSES EMPATHIQUES :
- "Je t'entends et je suis là pour toi 💙"
- "Tu n'es pas seul(e) dans cette situation"
- "C'est courageux de partager ce que tu ressens"
- "Prendre soin de sa santé mentale c'est important"

Réponds UNIQUEMENT en JSON valide :
{
  "message": "ta réponse empathique ici",
  "urgence": false,
  "orientation_psy": false
}`;

// ─── Stockage temporaire en mémoire ───────────────────────────────────────
const conversationsMemoire = {};

// ─── Numéros à ignorer ────────────────────────────────────────────────────
const NUMEROS_IGNORES = [
  '81746280333328@lid',
];

// // ─── Liste blanche (seuls ces numéros peuvent parler au bot) ──────────────
// const LISTE_BLANCHE = [
//   '221776028511@c.us', // numéro test 1
//   '221707773008@c.us', // numéro test 2
// ];

// ─── Numéro du psychologue ────────────────────────────────────────────────
const NUMERO_PSY = '221783360226@c.us';

// ─── Sauvegarder message dans Firebase ────────────────────────────────────
async function sauvegarderMessage(userId, role, contenu, meta = {}) {
  try {
    await db.collection('conversations').doc(userId).collection('messages').add({
      role,
      contenu,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ...meta,
    });
    await db.collection('conversations').doc(userId).set({
      userId,
      dernierMessage: contenu,
      dernierContact: admin.firestore.FieldValue.serverTimestamp(),
      urgence: meta.urgence || false,
      orientation_psy: meta.orientation_psy || false,
    }, { merge: true });
  } catch (err) {
    console.error('⚠️ Firebase save error:', err.message);
  }
}

// ─── Traitement message par Groq ──────────────────────────────────────────
async function traiterMessage(userId, messageUtilisateur) {
  if (!conversationsMemoire[userId]) {
    conversationsMemoire[userId] = [];
  }

  const historiqueTexte = conversationsMemoire[userId]
    .map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const promptComplet = `${SYSTEM_PROMPT}

${historiqueTexte ? 'Historique:\n' + historiqueTexte + '\n' : ''}
Nouveau message: ${messageUtilisateur}`;

  const result = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: promptComplet }],
    response_format: { type: 'json_object' },
    max_tokens: 500,
  });

  const texte = result.choices[0].message.content;

  let reponseIA;
  try {
    reponseIA = JSON.parse(texte);
  } catch {
    reponseIA = { message: texte, urgence: false, orientation_psy: false };
  }

  conversationsMemoire[userId].push({ role: 'user', content: messageUtilisateur });
  conversationsMemoire[userId].push({ role: 'assistant', content: reponseIA.message });

  return reponseIA;
}

// ─── Initialisation WhatsApp ──────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ],
    protocolTimeout: 120000,
  }
});

client.on('qr', (qr) => {
  console.log('=== SCANNE CE QR CODE AVEC WHATSAPP ===');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('🚀 MindBridge connecté à WhatsApp !');
});

client.on('message', async (msg) => {
  // Ignorer les messages envoyés par le bot lui-même
  if (msg.fromMe) return;
  // Ignorer newsletters et groupes
  if (msg.from === 'status@broadcast') return;
  if (msg.from.includes('@g.us')) return;
  if (msg.from.includes('@newsletter')) return;
  // Ignorer les numéros admin
  if (NUMEROS_IGNORES.includes(msg.from)) return;
  

  const userId = msg.from;

  try {
    // Récupérer le document de conversation
    const convDoc = await db.collection('conversations').doc(userId).get();

    // ── Traiter les vocaux ──────────────────────────────────────────────
    let messageTexte = msg.body;

    if (msg.hasMedia && msg.type === 'ptt') {
      console.log(`🎤 [WhatsApp] Vocal reçu de ${userId}`);
      try {
        // Attendre un peu avant de télécharger
        await new Promise(resolve => setTimeout(resolve, 2000));
        const media = await msg.downloadMedia();
        const buffer = Buffer.from(media.data, 'base64');
        const tempPath = path.join(__dirname, `vocal_${Date.now()}.ogg`);
        fs.writeFileSync(tempPath, buffer);

        const transcription = await groq.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: 'whisper-large-v3',
          language: null,
        });

        messageTexte = transcription.text;
        console.log(`📝 Transcription: ${messageTexte}`);
        fs.unlinkSync(tempPath);

      } catch (err) {
        console.error('❌ Erreur transcription complète:', err);
        await msg.reply('🎤 Désolé, je n\'ai pas pu comprendre votre message vocal. Pouvez-vous écrire votre message ?');
        return;
      }
    }

    if (!messageTexte) return;
    console.log(`📩 [WhatsApp] ${userId}: ${messageTexte}`);

    // ── Message de bienvenue si première fois ───────────────────────────
    if (!convDoc.exists || !convDoc.data().premierContact) {
      await client.sendMessage(userId,
        `💙 *Bienvenue sur MindBridge Africa*\n\n` +
        `Je suis votre espace d'écoute confidentiel, disponible 24h/24.\n\n` +
        `✅ Tout ce que vous partagez reste *strictement confidentiel*\n` +
        `✅ Je suis là pour vous écouter sans jugement\n` +
        `✅ En cas d'urgence, un psychologue humain interviendra\n\n` +
        `_Comment vous sentez-vous aujourd'hui ?_ 🌿`
      );
      await db.collection('conversations').doc(userId).set(
        { premierContact: true },
        { merge: true }
      );
    }

    // ── Vérifier si le bot est en pause pour ce patient ─────────────────
    if (convDoc.exists && convDoc.data().botPause) {
      console.log(`⏸️ Bot en pause pour ${userId} — psy a pris en charge`);
      return;
    }

    // ── Sauvegarder message utilisateur ────────────────────────────────
    await sauvegarderMessage(userId, 'user', messageTexte);

    // ── Appel Groq IA ───────────────────────────────────────────────────
    const analyse = await traiterMessage(userId, messageTexte);

    // ── Sauvegarder réponse IA ──────────────────────────────────────────
    await sauvegarderMessage(userId, 'assistant', analyse.message, {
      urgence: analyse.urgence,
      orientation_psy: analyse.orientation_psy,
    });

// ── Répondre sur WhatsApp ───────────────────────────────────────────
    if (analyse.urgence) {
      // Urgence critique → message spécial + arrêt des questions
      await msg.reply(
        `💙 Je sens que vous traversez un moment très difficile.\n\n` +
        `Vous méritez un soutien humain et professionnel. Je vais immédiatement vous mettre en contact avec notre psychologue partenaire qui vous contactera très prochainement.\n\n` +
        `*Vous n'êtes pas seul(e). Nous sommes là pour vous.* 🌿`
      );
    } else if (analyse.orientation_psy) {
      // Détresse modérée → orientation douce
      await msg.reply(
        `💙 Je vous entends, et ce que vous vivez mérite un accompagnement professionnel.\n\n` +
        `Je vous mets en relation avec notre psychologue partenaire qui pourra mieux vous aider et vous accompagner. Il vous contactera prochainement.\n\n` +
        `*Courage, vous faites le bon choix en en parlant.* 🌿`
      );
    } else {
      // Conversation normale → réponse IA
      await msg.reply(analyse.message);
    }

    // ── Alerte psy si urgence détectée ─────────────────────────────────
    if (analyse.urgence || analyse.orientation_psy) {
      // Mettre le bot en pause automatiquement
      await db.collection('conversations').doc(userId).set(
        { botPause: true },
        { merge: true }
      );
      console.log(`🚨 [ALERTE] Patient sensible: ${userId}`);

      await client.sendMessage(NUMERO_PSY,
        `🚨 *ALERTE MindBridge Africa*\n\n` +
        `Un patient nécessite une attention immédiate !\n\n` +
        `📱 Patient: ${userId.slice(0, 15)}...\n` +
        `💬 Dernier message: "${messageTexte}"\n` +
        `⚠️ Niveau: ${analyse.urgence ? 'URGENCE CRITIQUE' : 'Orientation recommandée'}\n\n` +
        `👉 Connectez-vous au dashboard pour intervenir.`
      );

      if (analyse.urgence) {
        await client.sendMessage(userId,
          `🆘 *Ressources d'urgence disponibles :*\n\n` +
          `👨‍⚕️ *Notre psychologue partenaire* va vous contacter très prochainement\n\n` +
          `📞 *Numéros utiles au Sénégal :*\n` +
          `• SAMU : *15*\n` +
          `• Pompiers : *18*\n` +
          `• Police secours : *17*\n` +
          `• Hôpital Fann (psychiatrie) : *+221 33 869 18 18*\n\n` +
          `💙 Vous n'êtes pas seul(e). Nous sommes là.`
        );
      }
    }

  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
});

client.initialize();

// ─── API Express ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.post('/api/envoyer-message', async (req, res) => {
  try {
    const { userId, message } = req.body;
    await client.sendMessage(userId, `👨‍⚕️ *Psychologue MindBridge :* ${message}`);
    await sauvegarderMessage(userId, 'assistant', `👨‍⚕️ Psychologue: ${message}`);
    res.json({ succes: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post('/api/prise-en-charge', async (req, res) => {
  try {
    const { userId } = req.body;
    await db.collection('conversations').doc(userId).set(
      { priseEnCharge: true, botPause: true },
      { merge: true }
    );
    await client.sendMessage(userId,
      `👨‍⚕️ *MindBridge Africa*\n\nBonjour, un psychologue partenaire va vous contacter très prochainement. Vous n'êtes pas seul(e). 💙`
    );
    res.json({ succes: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.post('/api/orienter', async (req, res) => {
  try {
    const { userId } = req.body;
    await db.collection('conversations').doc(userId).set(
      { orientation_psy: true },
      { merge: true }
    );
    await client.sendMessage(userId,
      `📋 *MindBridge Africa*\n\nNous vous orientons vers un psychologue partenaire qui pourra mieux vous accompagner. Vous serez contacté(e) prochainement. 💙`
    );
    res.json({ succes: true });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const snapshot = await db.collection('conversations')
      .orderBy('dernierContact', 'desc')
      .limit(50)
      .get();
    const conversations = [];
    snapshot.forEach(doc => {
      if (doc.id !== 'test') conversations.push({ id: doc.id, ...doc.data() });
    });
    res.json({ succes: true, conversations });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.get('/api/conversations/:userId/messages', async (req, res) => {
  try {
    const snapshot = await db.collection('conversations')
      .doc(req.params.userId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limit(100)
      .get();
    const messages = [];
    snapshot.forEach(doc => messages.push(doc.data()));
    res.json({ succes: true, messages });
  } catch (err) {
    res.status(500).json({ erreur: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ statut: '✅ MindBridge Africa opérationnelle', version: '1.0.0', ia: 'Groq' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`👉 API active sur le port ${PORT}`);
});