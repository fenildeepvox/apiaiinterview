const OpenAI = require('openai');
const {
  StudentsWithJobPost,
  JobPost,
  StudentInterviewAnswer,
  InterviewQuestion,
} = require('../models');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const summariseAlerts = (alerts = []) => {
  if (!alerts.length) return 'No proctoring alerts were raised.';

  const counts = {};
  alerts.forEach(({ type, severity }) => {
    const key = `${severity}:${type}`;
    counts[key] = (counts[key] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([key, n]) => {
      const [severity, type] = key.split(':');
      return `  • [${severity}] ${type} × ${n}`;
    })
    .join('\n');
};

// ─── Main handler ────────────────────────────────────────────────────────────

exports.generateAiAnalytics = async (req, res) => {
  try {
    const { studentId } = req.body;

    if (!studentId) {
      return res
        .status(400)
        .json({ success: false, message: 'studentId is required.' });
    }

    // ── Fetch student with all related data ──────────────────────────────────
    const student = await StudentsWithJobPost.findByPk(studentId, {
      include: [
        { model: JobPost, as: 'JobPost' },
        {
          model: StudentInterviewAnswer,
          as: 'StudentInterviewAnswer',
          include: [{ model: InterviewQuestion, as: 'Question' }],
        },
      ],
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: `Student with id ${studentId} not found.`,
      });
    }

    // ── Return cached analytics if already generated ─────────────────────────
    if (student.behavioral_analysis) {
      const cached = student.toJSON();
      return res.status(200).json({
        success: true,
        message: 'already generated',
      });
    }

    // ── Destructure fields ───────────────────────────────────────────────────
    const {
      id,
      name,
      educations = [],
      skills = [],
      location,
      residenceLocation,
      highestQualification,
      experienceLevel,
      overallScore,
      totalScore,
      scores = {},
      grade,
      averageResponseTime,
      attemptedQuestions,
      duration,
      status,
      reason,
      categoryPercentage = {},
      proctoringAlerts = [],
      photoUrl,
      interviewVideoLink,
      JobPost: jobData = {},
      StudentInterviewAnswer: answers = [],
    } = student.toJSON();

    // ── Build compact Q&A list for the prompt (cap at 60) ───────────────────
    const trimmedAnswers = answers.slice(0, 60).map((a) => ({
      type: a.Question?.type || '',
      category: a.Question?.category || '',
      difficulty: a.Question?.difficulty || '',
      q: a.Question?.question || '',
      answer: a.answer || '',
      score: a.score,
      aiEvaluation: a.aiEvaluation || '',
      responseTime: Number(a.responseTime || 0),
    }));

    const catPct = categoryPercentage?.categoryWisePercentage || {};
    const overallPct = categoryPercentage?.overallPercentage ?? 0;
    const alertSummary = summariseAlerts(proctoringAlerts);

    // ── Prompts ──────────────────────────────────────────────────────────────
    const systemPrompt = `You are an expert HR analytics engine. Given raw interview data for a candidate, produce a detailed, honest, and actionable JSON analytics report.

Return ONLY valid JSON—no markdown fences, no extra commentary. The JSON must match this exact schema:

{
  "aiEvaluationSummary": {
    "summary": "<2-3 sentence overall evaluation>",
    "keyStrengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
    "areasOfGrowth": ["<area 1>", "<area 2>", "<area 3>"]
  },
  "behavioral_analysis": {
    "confidence": <integer 0-100>,
    "engagement": <integer 0-100>,
    "eye_contact": <integer 0-100>,
    "facial_expressions": <integer 0-100>,
    "gestures": <integer 0-100>,
    "posture": <integer 0-100>,
    "voice_tone": <integer 0-100>
  },
  "performanceBreakdown": {
    "behavior": {
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "body_language": {
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "communicationSkills": {
      "answeredAveragePercentage": <integer 0-100>,
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "confidenceLevel": {
      "answeredAveragePercentage": <integer 0-100>,
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "culturalFit": {
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "leadershipPotential": {
      "answeredAveragePercentage": <integer 0-100>,
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "problemSolving": {
      "answeredAveragePercentage": <integer 0-100>,
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    },
    "technicalKnowledge": {
      "answeredAveragePercentage": <integer 0-100>,
      "overallAveragePercentage": <integer 0-100>,
      "summary": "<sentence>"
    }
  },
  "quickStats": {
    "communicationSkills": "<Excellent|Good|Fair|Poor>",
    "confidenceLevel": "<Excellent|Good|Fair|Poor>",
    "leadershipPotential": "<Excellent|Good|Fair|Poor>",
    "problemSolving": "<Excellent|Good|Fair|Poor>",
    "technicalKnowledge": "<Excellent|Good|Fair|Poor>"
  },
  "recommendations": {
    "recommendation": "<Highly Recommended|Recommended|Consider with reservations|Not Recommended>",
    "summary": "<2-sentence recommendation rationale>"
  },
  "video_analysis_insights": {
    "keyStrengths": ["<strength 1>", "<strength 2>"],
    "areasOfGrowth": ["<area 1>", "<area 2>"],
    "positive_indicators": ["<indicator 1>", "<indicator 2>", "<indicator 3>"],
    "areas_for_improvement": ["<improvement 1>"],
    "recommendations": ["<recommendation 1>"]
  }
}

Rules:
- Base behavioral_analysis on actual answer quality, response times, proctoring alerts and category scores. Do NOT make all values identical.
- Critical proctoring alerts (e.g. multiple_faces_detected) should lower confidence and eye_contact appropriately.
- If no video link is provided, estimate eye_contact/gestures/posture/facial_expressions from text performance.
- Be specific—reference the job role and candidate's education/skills where relevant.
- All percentages must be integers in [0, 100].
- quickStats values must be one of: Excellent, Good, Fair, Poor.`;

    const userPrompt = `CANDIDATE: ${name}
Education: ${educations.map((e) => `${e.type} (${e.stream}) – ${e.percentage}% – ${e.yearOfPassing}`).join(', ')}
Highest Qualification: ${highestQualification || 'N/A'}
Skills: ${(skills || []).join(', ') || 'Not specified'}
Location: ${location || 'N/A'}
Experience Level: ${experienceLevel || 'Entry level'}

JOB: ${jobData.jobTitle || 'N/A'} at ${jobData.company || 'N/A'} (${jobData.jobType || ''}, ${jobData.experienceLevel || ''})
Department: ${jobData.department || 'N/A'}
Job description snippet: ${(jobData.jobDescription || '').slice(0, 400)}

INTERVIEW STATS:
- Status: ${status} | Reason: ${reason || 'N/A'}
- Grade: ${grade} | Overall: ${overallScore}/${totalScore} (${overallPct}%)
- Attempted: ${attemptedQuestions} questions in ${duration} min
- Avg response time: ${averageResponseTime}s
- Category scores: ${JSON.stringify(catPct)}
- Pre-computed scores: ${JSON.stringify(scores)}
- Video recording available: ${interviewVideoLink ? 'Yes' : 'No'}
- Photo available: ${photoUrl ? 'Yes' : 'No'}

PROCTORING:
${alertSummary}

QUESTIONS & ANSWERS (sample, up to 60):
${trimmedAnswers
  .map(
    (a, i) =>
      `[${i + 1}] (${a.type} | ${a.category} | ${a.difficulty})\n    Q: ${a.q}\n    A: ${a.answer}\n    Score: ${a.score} | Time: ${a.responseTime}s | AI eval: ${a.aiEvaluation}`,
  )
  .join('\n')}`;

    // ── Call OpenAI ──────────────────────────────────────────────────────────
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    console.log('completion', JSON.stringify(completion, null, 2));
    const rawContent = completion.choices[0]?.message?.content || '{}';
    const analytics = JSON.parse(rawContent);

    let damiscores = {
      communication:
        analytics?.performanceBreakdown?.communicationSkills
          ?.overallAveragePercentage ?? 0,
      technical:
        analytics?.performanceBreakdown?.technicalKnowledge
          ?.overallAveragePercentage ?? 0,
      problemSolving:
        analytics?.performanceBreakdown?.problemSolving
          ?.overallAveragePercentage ?? 0,
      leadership:
        analytics?.performanceBreakdown?.leadershipPotential
          ?.overallAveragePercentage ?? 0,
      bodyLanguage:
        analytics?.performanceBreakdown?.body_language
          ?.overallAveragePercentage ?? 0,
      confidence:
        analytics?.performanceBreakdown?.confidenceLevel
          ?.overallAveragePercentage ?? 0,
    };

    // Persist analytics back to the student record
    await StudentsWithJobPost.update(
      {
        aiEvaluationSummary: analytics.aiEvaluationSummary,
        behavioral_analysis: analytics.behavioral_analysis,
        performanceBreakdown: analytics.performanceBreakdown,
        quickStats: analytics.quickStats,
        recommendations: analytics.recommendations,
        video_analysis_insights: analytics.video_analysis_insights,
        scores: damiscores,
      },
      { where: { id: studentId } },
    );

    return res.status(200).json({
      success: true,
      studentId: id,
      name,
      photoUrl: photoUrl || null,
      interviewVideoLink: interviewVideoLink || null,
      ...analytics,
      scores: damiscores,
    });
  } catch (error) {
    console.error('❌ AI Analytics error:', error);

    if (error?.status === 401) {
      return res.status(500).json({
        success: false,
        message: 'Invalid OpenAI API key. Please check OPENAI_API_KEY in .env',
      });
    }

    if (error instanceof SyntaxError) {
      return res.status(500).json({
        success: false,
        message: 'AI returned malformed JSON. Please retry.',
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to generate AI analytics',
      error: error.message,
    });
  }
};
