require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Reconstruct the Schema so we don't depend on express app starting
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
    type: String,
    tags: [String],
    importance: String,
    description: String
});
const Question = mongoose.model('Question', questionSchema);

async function seed() {
    try {
        console.log('🔄 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('✅ Connected securely.');

        const filePath = path.join(__dirname, 'data', 'all_questions.json');
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        
        console.log('🧹 Clearing existing database...');
        await Question.deleteMany({});

        const flatQuestions = [];
        
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

        console.log(`📦 Pushing ${flatQuestions.length} medical questions to Atlas...`);
        await Question.insertMany(flatQuestions);
        
        console.log('🎉 Database seeding complete!');
        process.exit(0);
    } catch (err) {
        console.error('❌ SEED ERROR:', err.message);
        process.exit(1);
    }
}

seed();
