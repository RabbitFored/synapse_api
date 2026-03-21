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
// 🧱 2. MONGOOSE SCHEMA
// ==========================================
const questionSchema = new mongoose.Schema({
    yearId: String,
    yearName: String,
    subjectId: String,
    subjectName: String,
    paperId: String,
    paperName: String,
    chapterId: String,
    chapterName: String,
    title: String,
    type: String, // 'long' or 'short'
    tags: [String],
    importance: String,
    description: String
});
const Question = mongoose.model('Question', questionSchema);

// ==========================================
// 🌱 3. SEED DATABASE ENDPOINT
// ==========================================
// Call this once to parse the local JSON file and push it natively into MongoDB
app.post('/api/v1/seed', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'all_questions.json');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "all_questions.json not found in data folder" });
        }
        
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        
        await Question.deleteMany({}); // Clear existing database

        const flatQuestions = [];
        
        // Flatten the nested hierarchy into individual MongoDB documents
        const years = data.years || [];
        for (const year of years) {
            const subjects = year.subjects || [];
            for (const sub of subjects) {
                const papers = sub.papers || [];
                const processChapters = (chaps, paperId = null, paperName = null) => {
                    for (const chap of chaps) {
                        const qs = chap.questions || [];
                        for (const q of qs) {
                            flatQuestions.push({
                                yearId: year.id, yearName: year.name,
                                subjectId: sub.id, subjectName: sub.name,
                                paperId: paperId, paperName: paperName,
                                chapterId: chap.id, chapterName: chap.name,
                                title: q.title, type: q.type,
                                tags: q.tags, importance: q.importance,
                                description: q.description
                            });
                        }
                    }
                };

                if (papers.length > 0) {
                    for (const paper of papers) {
                        processChapters(paper.chapters || [], paper.id, paper.name);
                    }
                } else {
                    processChapters(sub.chapters || []);
                }
            }
        }

        await Question.insertMany(flatQuestions);
        res.json({ message: `✅ Successfully seeded ${flatQuestions.length} questions into MongoDB!` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error during seeding" });
    }
});

// ==========================================
// 🚀 4. HYDRATION ENDPOINT (For Flutter)
// ==========================================
app.get('/api/v1/sync/all_questions', async (req, res) => {
    try {
        // Query flat documents from MongoDB
        const allQuestions = await Question.find();
        
        // Reconstruct the deep JSON tree that Flutter expects
        const tree = { years: [] };

        allQuestions.forEach(q => {
            // Find or create Year
            let year = tree.years.find(y => y.id === q.yearId);
            if (!year) {
                year = { id: q.yearId, name: q.yearName, subjects: [] };
                tree.years.push(year);
            }

            // Find or create Subject
            let subject = year.subjects.find(s => s.id === q.subjectId);
            if (!subject) {
                subject = { id: q.subjectId, name: q.subjectName, chapters: [], papers: [] };
                year.subjects.push(subject);
            }

            let targetChaptersArray = subject.chapters;

            // Find or create Paper (if exists)
            if (q.paperId) {
                let paper = subject.papers.find(p => p.id === q.paperId);
                if (!paper) {
                    paper = { id: q.paperId, name: q.paperName, chapters: [] };
                    subject.papers.push(paper);
                }
                targetChaptersArray = paper.chapters;
            }

            // Find or create Chapter
            let chapter = targetChaptersArray.find(c => c.id === q.chapterId);
            if (!chapter) {
                chapter = { id: q.chapterId, name: q.chapterName, questions: [] };
                targetChaptersArray.push(chapter);
            }

            // Add Question
            chapter.questions.push({
                id: q._id,
                title: q.title,
                type: q.type,
                tags: q.tags,
                importance: q.importance,
                description: q.description
            });
        });

        res.json(tree);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server Error building tree' });
    }
});

// ==========================================
// 📚 5. CRUD ENDPOINTS
// ==========================================

// GET all flat questions (Admin view)
app.get('/api/v1/questions', async (req, res) => {
    try {
        const questions = await Question.find();
        res.json({ total: questions.length, questions });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
});

// POST single new question
app.post('/api/v1/questions', async (req, res) => {
    try {
        const newQuestion = new Question(req.body);
        await newQuestion.save();
        res.status(201).json(newQuestion);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save question' });
    }
});

// DELETE single question
app.delete('/api/v1/questions/:id', async (req, res) => {
    try {
        await Question.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted successfully" });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Synapse Backend running on port ${PORT}`);
});
