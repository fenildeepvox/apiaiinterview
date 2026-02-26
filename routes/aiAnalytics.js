const express = require('express');
const router = express.Router();
const { generateAiAnalytics } = require('../controllers/aiAnalyticsController');

/**
 * POST /api/ai-analytics
 *
 * Body: { studentId: <number> }
 *
 * Fetches the student record (with JobPost + StudentInterviewAnswer + Question)
 * and returns AI-generated analytics:
 *   aiEvaluationSummary, behavioral_analysis, performanceBreakdown,
 *   quickStats, recommendations, video_analysis_insights
 */
router.post('/', generateAiAnalytics);

module.exports = router;
