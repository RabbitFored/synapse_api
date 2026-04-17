require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// --- Schemas (must match index.js) ---
const topicSchema = new mongoose.Schema({
    topic_name: { type: String, required: true },
    display_title: String,
    subject: { type: String, required: true, index: true },
    frequency_count: { type: Number, default: 0 },
    study_checklist: [String],
    high_yield_angles: [String],
    year_frequency: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
const Topic = mongoose.model('Topic', topicSchema);

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
const Question = mongoose.model('Question', questionSchema);

async function seed() {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected.');

        const filePath = path.join(__dirname, 'data', 'clustered_topics.json');
        if (!fs.existsSync(filePath)) {
            console.error('❌ clustered_topics.json not found in data/');
            process.exit(1);
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const topics = JSON.parse(raw);
        const subject = topics[0]?.subject || 'Pathology';

        console.log(`🗑️  Clearing existing ${subject} data...`);
        const existingTopics = await Topic.find({ subject });
        const topicIds = existingTopics.map(t => t._id);
        await Question.deleteMany({ topic_id: { $in: topicIds } });
        await Topic.deleteMany({ subject });

        let topicsInserted = 0;
        let questionsInserted = 0;

        for (const t of topics) {
            const topicDoc = await Topic.create({
                topic_name: t.topic_name,
                display_title: t.display_title || t.topic_name,
                subject: t.subject,
                paper: t.paper || 'Unknown',
                chapter: t.chapter || 'General',
                frequency_count: t.frequency_count || 0,
                study_checklist: t.study_checklist || [],
                high_yield_angles: t.high_yield_angles || [],
                year_frequency: t.year_frequency || {},
            });
            topicsInserted++;

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

        console.log(`🎉 Seeded ${topicsInserted} topics and ${questionsInserted} questions for ${subject}!`);
        process.exit(0);
    } catch (err) {
        console.error('❌ SEED ERROR:', err.message);
        process.exit(1);
    }
}

seed();
