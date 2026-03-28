require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🔗 1. MONGODB CONNECTION
// ==========================================
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => {
      console.error('❌ MongoDB Connection Error:', err);
      process.exit(1);
  });

// ==========================================
// 🧱 2. MONGOOSE SCHEMAS (New Topic-Based)
// ==========================================

// --- Topics Collection ---
const topicSchema = new mongoose.Schema({
    topic_name: { type: String, required: true },
    display_title: String,
    subject: { type: String, required: true, index: true },
    frequency_count: { type: Number, default: 0 },
    study_checklist: [String],
    high_yield_angles: [String],
    year_frequency: mongoose.Schema.Types.Mixed, // { "2008": 1, "2009": 2 }
}, { timestamps: true });

topicSchema.index({ subject: 1, frequency_count: -1 });
const Topic = mongoose.model('Topic', topicSchema);

// --- Questions Collection ---
const questionSchema = new mongoose.Schema({
    topic_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true, index: true },
    text: { type: String, required: true },
    year: Number,
    month: String,
    paper: String,
    paper_title: String,
    section: String,
    marks: { type: Number, default: 0 },
    subject: String,
}, { timestamps: true });

questionSchema.index({ topic_id: 1 });
questionSchema.index({ subject: 1, year: -1 });
const Question = mongoose.model('Question', questionSchema);

// ==========================================
// 🌱 3. SEED ENDPOINT (From clustered_topics.json)
// ==========================================
app.post('/api/v1/seed/topics', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'clustered_topics.json');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "clustered_topics.json not found in data folder" });
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const topics = JSON.parse(raw);
        const subject = topics[0]?.subject || 'Pathology';

        // Clear existing data for this subject
        console.log(`🗑️  Clearing existing ${subject} data...`);
        const existingTopics = await Topic.find({ subject });
        const topicIds = existingTopics.map(t => t._id);
        await Question.deleteMany({ topic_id: { $in: topicIds } });
        await Topic.deleteMany({ subject });

        let topicsInserted = 0;
        let questionsInserted = 0;

        for (const t of topics) {
            // Insert topic
            const topicDoc = await Topic.create({
                topic_name: t.topic_name,
                display_title: t.display_title || t.topic_name,
                subject: t.subject,
                frequency_count: t.frequency_count || 0,
                study_checklist: t.study_checklist || [],
                high_yield_angles: t.high_yield_angles || [],
                year_frequency: t.year_frequency || {},
            });
            topicsInserted++;

            // Insert questions linked to this topic
            const questions = (t.questions || []).map(q => ({
                topic_id: topicDoc._id,
                text: q.text,
                year: q.year,
                month: q.month,
                paper: q.paper,
                paper_title: q.paper_title,
                section: q.section,
                marks: q.marks || 0,
                subject: t.subject,
            }));

            if (questions.length > 0) {
                await Question.insertMany(questions);
                questionsInserted += questions.length;
            }
        }

        res.json({
            message: `✅ Seeded ${topicsInserted} topics and ${questionsInserted} questions for ${subject}`,
            topics: topicsInserted,
            questions: questionsInserted,
        });
    } catch (error) {
        console.error('Seed Error:', error);
        res.status(500).json({ error: "Server error during seeding" });
    }
});

// ==========================================
// 🚀 4. SYNC ENDPOINT — Plexus-Style Topics
// ==========================================
// This is what the Flutter app calls to get all topics for a subject
app.get('/api/v1/sync/topics', async (req, res) => {
    try {
        const subject = req.query.subject; // e.g., ?subject=Pathology
        const chapter = req.query.chapter;

        const query = {};
        if (subject) query.subject = subject;
        if (chapter) query.chapter = chapter;
        const topics = await Topic.find(query).sort({ frequency_count: -1 }).lean();

        // Optimize: Fetch all questions in a single query instead of N queries
        const topicIds = topics.map(t => t._id);
        const allQuestions = await Question.find({ topic_id: { $in: topicIds } })
            .sort({ year: -1 })
            .lean();

        // Group questions by topicId in memory
        const questionsByTopic = {};
        for (const q of allQuestions) {
            const tIdStr = q.topic_id.toString();
            if (!questionsByTopic[tIdStr]) {
                questionsByTopic[tIdStr] = [];
            }
            questionsByTopic[tIdStr].push({
                _id: q._id,
                text: q.text,
                year: q.year,
                month: q.month,
                paper: q.paper,
                paper_title: q.paper_title,
                section: q.section,
                marks: q.marks,
            });
        }

        // Attach grouped questions to their respective topics
        const result = topics.map(t => ({
            _id: t._id,
            topic_name: t.topic_name,
            display_title: t.display_title,
            subject: t.subject,
            paper: t.paper,
            chapter: t.chapter,
            frequency_count: t.frequency_count,
            study_checklist: t.study_checklist,
            high_yield_angles: t.high_yield_angles,
            year_frequency: t.year_frequency,
            questions: questionsByTopic[t._id.toString()] || [],
        }));

        res.json({
            subject: subject || 'all',
            total_topics: result.length,
            total_questions: result.reduce((acc, t) => acc + t.questions.length, 0),
            topics: result,
        });
    } catch (error) {
        console.error('Sync Error:', error);
        res.status(500).json({ error: 'Server error fetching topics' });
    }
});

// ==========================================
// 🔙 5. LEGACY SYNC ENDPOINT (Backward Compat)
// ==========================================
// Maps new topic data back to the old years->subjects->chapters format
// so the existing Flutter app still works until fully migrated
app.get('/api/v1/sync/all_questions', async (req, res) => {
    try {
        const topics = await Topic.find().sort({ frequency_count: -1 }).lean();

        // Group topics by subject
        const subjectMap = {};
        for (const t of topics) {
            if (!subjectMap[t.subject]) {
                subjectMap[t.subject] = { p1: [], p2: [] };
            }

            const questions = await Question.find({ topic_id: t._id }).sort({ year: -1 }).lean();

            // Determine which paper this topic mostly belongs to
            let p1Count = 0, p2Count = 0;
            questions.forEach(q => {
                if (q.paper === 'p1') p1Count++;
                else p2Count++;
            });

            const chapter = {
                id: t._id.toString(),
                name: `${t.display_title || t.topic_name} [${t.frequency_count} PYQs]`,
                questions: questions.map(q => ({
                    id: q._id.toString(),
                    title: q.text.length > 40 ? q.text.substring(0, 40) + '...' : q.text,
                    type: q.marks >= 10 ? 'long' : 'short',
                    tags: [String(q.year)],
                    importance: t.frequency_count >= 3 ? 'high' : 'normal',
                    description: q.text,
                })),
            };

            if (p1Count >= p2Count) {
                subjectMap[t.subject].p1.push(chapter);
            } else {
                subjectMap[t.subject].p2.push(chapter);
            }
        }

        // Build legacy tree
        const subjects = Object.entries(subjectMap).map(([name, papers]) => ({
            id: name.toLowerCase().replace(/\s+/g, '_'),
            name: name.toUpperCase(),
            papers: [
                { id: 'paper_1', name: 'Paper 1', chapters: papers.p1 },
                { id: 'paper_2', name: 'Paper 2', chapters: papers.p2 },
            ],
        }));

        res.json({
            years: [{
                id: 'year_2',
                name: '2nd Year MBBS',
                subjects,
            }],
        });
    } catch (error) {
        console.error('Legacy Sync Error:', error);
        res.status(500).json({ error: 'Server Error building tree' });
    }
});

// ==========================================
// 📊 6. STATS ENDPOINT
// ==========================================
app.get('/api/v1/stats', async (req, res) => {
    try {
        const topicCount = await Topic.countDocuments();
        const questionCount = await Question.countDocuments();
        const subjects = await Topic.distinct('subject');

        const perSubject = {};
        for (const s of subjects) {
            perSubject[s] = {
                topics: await Topic.countDocuments({ subject: s }),
                questions: await Question.countDocuments({ subject: s }),
            };
        }

        res.json({ total_topics: topicCount, total_questions: questionCount, subjects: perSubject });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

// ==========================================
// 🏥 7. HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Synapse Backend running on port ${PORT}`);
});
