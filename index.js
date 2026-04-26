require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');
const cache = apicache.middleware;
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());

// ==========================================
// 🔗 1. MONGODB CONNECTION
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => {
      console.error('❌ MongoDB Connection Error:', err);
      process.exit(1);
  });

// ==========================================
// 🛡️ SECURITY & RATE LIMITS
// ==========================================
// Trust the reverse proxy (CapRover/nginx) so express-rate-limit
// reads the real client IP from X-Forwarded-For instead of crashing.
app.set('trust proxy', 1);
const syncLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute per IP for heavy sync ops
    message: { error: 'Too many sync requests from this IP, please try again next minute' }
});

// ==========================================
// 🧱 2. MONGOOSE SCHEMAS (New Topic-Based)
// ==========================================

// --- Topics Collection ---
const topicSchema = new mongoose.Schema({
    topic_name: { type: String, required: true },
    display_title: String,
    subject: { type: String, required: true, index: true },
    university: { type: String, index: true },         // e.g. 'TNMGRMU', 'RGUHS'
    chapter: { type: String, default: 'General' },
    paper: String,                                    // display name
    paper_id: { type: String, default: 'paper_1' },   // machine key
    ai_verified: { type: Boolean, default: true },
    confidence_score: { type: Number, default: 100 },
    is_high_yield: { type: Boolean, default: false },  // freq >= 3
    frequency_count: { type: Number, default: 0 },
    study_checklist: [String],
    high_yield_angles: [String],
    year_frequency: mongoose.Schema.Types.Mixed, // { "2016": 1, "2017": 2 }
}, { timestamps: true });

topicSchema.index({ subject: 1, frequency_count: -1 });
topicSchema.index({ subject: 1, paper_id: 1, chapter: 1 });
topicSchema.index({ subject: 1, is_high_yield: 1 });
topicSchema.index({ ai_verified: 1 });
const Topic = mongoose.model('Topic', topicSchema);

// --- Questions Collection ---
const questionSchema = new mongoose.Schema({
    topic_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', required: true, index: true },
    question_id: { type: String, index: true },
    text: { type: String, required: true },
    year: Number,
    month: String,
    paper: String,
    paper_title: String,
    section: String,
    marks: { type: Number, default: 0 },
    subject: String,
    university: String,                                // e.g. 'TNMGRMU', 'RGUHS'
    options: mongoose.Schema.Types.Mixed,
    qp_code: String,
}, { timestamps: true });

questionSchema.index({ topic_id: 1 });
questionSchema.index({ subject: 1, year: -1 });
const Question = mongoose.model('Question', questionSchema);

// ==========================================
// 🗑️ (Legacy Seed Endpoint Removed)
// Seeding is now handled completely by synapse_seed upserts
// ==========================================


// ==========================================
// 🚀 4. SYNC ENDPOINT — Plexus-Style Topics
// ==========================================
// This is what the Flutter app calls to get all topics for a subject
app.get('/api/v1/sync/topics', syncLimiter, cache('5 minutes'), async (req, res) => {
    try {
        // Sanitize to string to prevent NoSQL object injection ($ne, $gt, etc)
        const subject = req.query.subject ? String(req.query.subject) : undefined;
        const university = req.query.university ? String(req.query.university) : undefined;
        const chapter = req.query.chapter ? String(req.query.chapter) : undefined;
        const paper_id = req.query.paper_id ? String(req.query.paper_id) : undefined;
        const high_yield = req.query.high_yield ? String(req.query.high_yield) : undefined;

        const query = {};
        if (subject) query.subject = subject;
        if (university) query.university = university;
        if (chapter) query.chapter = chapter;
        if (paper_id) query.paper_id = paper_id;
        if (high_yield === 'true') query.is_high_yield = true;
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
                options: q.options,
                qp_code: q.qp_code,
                question_id: q.question_id,
            });
        }

        // Attach grouped questions to their respective topics
        const result = topics.map(t => ({
            _id: t._id,
            topic_name: t.topic_name,
            display_title: t.display_title,
            subject: t.subject,
            chapter: t.chapter || 'General',
            paper: t.paper || 'Unknown',
            paper_id: t.paper_id || 'paper_1',
            frequency_count: t.frequency_count,
            is_high_yield: t.is_high_yield,
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
app.get('/api/v1/sync/all_questions', syncLimiter, cache('60 minutes'), async (req, res) => {
    try {
        const university = req.query.university ? String(req.query.university) : undefined;
        const legacyQuery = university ? { university } : {};
        // Fetch all topics + all questions in 2 queries (no N+1)
        const topics = await Topic.find(legacyQuery).sort({ frequency_count: -1 }).lean();
        const topicIds = topics.map(t => t._id);
        const allQuestions = await Question.find({ topic_id: { $in: topicIds } })
            .sort({ year: -1 }).lean();

        // Group questions by topic_id
        const qByTopic = {};
        for (const q of allQuestions) {
            const tid = q.topic_id.toString();
            if (!qByTopic[tid]) qByTopic[tid] = [];
            qByTopic[tid].push(q);
        }

        // Group topics by subject + paper_id (pre-computed, no guessing)
        const subjectMap = {};
        for (const t of topics) {
            if (!subjectMap[t.subject]) {
                subjectMap[t.subject] = { paper_1: [], paper_2: [] };
            }

            const questions = qByTopic[t._id.toString()] || [];
            const chapter = {
                id: t._id.toString(),
                name: `${t.display_title || t.topic_name} [${t.frequency_count} PYQs]`,
                questions: questions.map(q => ({
                    id: q.question_id || q._id.toString(),
                    title: q.text.length > 40 ? q.text.substring(0, 40) + '...' : q.text,
                    type: q.marks >= 10 ? 'long' : (q.section === 'MCQ' ? 'mcq' : 'short'),
                    tags: [String(q.year)],
                    importance: t.is_high_yield ? 'high' : 'normal',
                    description: q.text,
                    options: q.options,
                })),
            };

            // Use pre-computed paper_id — normalize p1/p2 ↔ paper_1/paper_2
            const rawPaperId = (t.paper_id || 'paper_1').toLowerCase().replace(/[\s_-]/g, '');
            const isPaper2 = rawPaperId === 'p2' || rawPaperId === 'paper2' || rawPaperId === 'paperii';
            if (isPaper2) {
                subjectMap[t.subject].paper_2.push(chapter);
            } else {
                subjectMap[t.subject].paper_1.push(chapter);
            }
        }

        // Determine phase group per subject
        const phaseGroupings = {
            'phase_1': { name: 'Phase 1', subjects: ['anatomy', 'physiology', 'biochemistry'], data: [] },
            'phase_2': { name: 'Phase 2', subjects: ['pathology', 'pharmacology', 'microbiology'], data: [] },
            'phase_3_part_1': { name: 'Phase 3 Part 1', subjects: ['community_medicine', 'opthalmology', 'otorhinolaryngology', 'forensic_medicine'], data: [] },
            'phase_3_part_2': { name: 'Phase 3 Part 2', subjects: ['general_medicine', 'general_surgery', 'obstetrics_and_gynaecology', 'pediatrics', 'orthopaedics'], data: [] }
        };

        for (const [name, papers] of Object.entries(subjectMap)) {
            const subjectId = name.toLowerCase().replace(/\s+/g, '_');
            const subjectEntry = {
                id: subjectId,
                name: name.toUpperCase(),
                papers: [
                    { id: 'paper_1', name: 'Paper 1', chapters: papers.paper_1 },
                    { id: 'paper_2', name: 'Paper 2', chapters: papers.paper_2 },
                ],
            };
            
            // Route to correct phase group
            let matched = false;
            for (const [phaseKey, phaseObj] of Object.entries(phaseGroupings)) {
                if (phaseObj.subjects.includes(subjectId)) {
                    phaseObj.data.push(subjectEntry);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                // Fallback for unmapped subjects
                if (!phaseGroupings['others']) {
                    phaseGroupings['others'] = { name: 'Other Subjects', subjects: [], data: [] };
                }
                phaseGroupings['others'].data.push(subjectEntry);
            }
        }

        const years = [];
        for (const [phaseKey, phaseObj] of Object.entries(phaseGroupings)) {
            if (phaseObj.data.length > 0) {
                years.push({ id: phaseKey, name: phaseObj.name, subjects: phaseObj.data });
            }
        }

        res.json({ years });
    } catch (error) {
        console.error('Legacy Sync Error:', error);
        res.status(500).json({ error: 'Server Error building tree' });
    }
});

// ==========================================
// 📋 5b. CHAPTERS ENDPOINT — Aggregated chapter list
// ==========================================
app.get('/api/v1/chapters', cache('5 minutes'), async (req, res) => {
    try {
        const subject = req.query.subject ? String(req.query.subject) : undefined;
        const university = req.query.university ? String(req.query.university) : undefined;
        const paper_id = req.query.paper_id ? String(req.query.paper_id) : undefined;
        
        const match = {};
        if (subject) match.subject = subject;
        if (university) match.university = university;
        if (paper_id) match.paper_id = paper_id;

        const chapters = await Topic.aggregate([
            { $match: match },
            { $group: {
                _id: '$chapter',
                topic_count: { $sum: 1 },
                question_count: { $sum: '$frequency_count' },
                high_yield_count: { $sum: { $cond: ['$is_high_yield', 1, 0] } },
            }},
            { $sort: { _id: 1 } },
        ]);

        res.json({
            subject: subject || 'all',
            paper_id: paper_id || 'all',
            total_chapters: chapters.length,
            chapters: chapters.map(c => ({
                name: c._id,
                topic_count: c.topic_count,
                question_count: c.question_count,
                high_yield_count: c.high_yield_count,
            })),
        });
    } catch (error) {
        console.error('Chapters Error:', error);
        res.status(500).json({ error: 'Server error fetching chapters' });
    }
});

// ==========================================
// 📊 6. STATS ENDPOINT
// ==========================================
app.get('/api/v1/stats', cache('10 minutes'), async (req, res) => {
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
// 🛡️ 7. ADMIN HITL ENDPOINTS
// ==========================================

// GET /api/v1/admin/unverified_topics
app.get('/api/v1/admin/unverified_topics', async (req, res) => {
    try {
        const university = req.query.university ? String(req.query.university) : undefined;
        let query = { ai_verified: false };
        if (university) query.university = university;

        // Sort by confidence score ascending (lowest confidence first)
        const topics = await Topic.find(query).sort({ confidence_score: 1, subject: 1 });
        res.json({ success: true, count: topics.length, data: topics });
    } catch (err) {
        console.error('Error fetching unverified topics:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/v1/admin/verify_topic
app.post('/api/v1/admin/verify_topic', async (req, res) => {
    try {
        const { topic_id, new_chapter, is_approved } = req.body;
        if (!topic_id) {
            return res.status(400).json({ error: 'topic_id required' });
        }
        const topic = await Topic.findById(topic_id);
        if (!topic) {
            return res.status(404).json({ error: 'Topic not found' });
        }
        
        if (new_chapter) {
            topic.chapter = new_chapter;
        }
        topic.ai_verified = true;
        await topic.save();

        res.json({ success: true, message: 'Topic verified successfully' });
    } catch (err) {
        console.error('Error verifying topic:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// 🏥 8. HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Synapse Backend running on port ${PORT}`);
});
