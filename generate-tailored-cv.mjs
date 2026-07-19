import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import yaml from 'js-yaml';
// Shared runtime-settings loader (env > config/runtime.json > unset) so a key or
// model saved from the PWA Integrations tab reaches the CV generator too — the
// evaluator (gemini-eval.mjs) already reads through this loader; this keeps the
// two Gemini call sites consistent instead of the CV path reading raw env only.
import { resolveSetting, DEFAULT_GEMINI_MODEL } from './runtime-settings.mjs';

// Load environment variables
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // Dotenv is optional
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Paths
const PATHS = {
  template: join(__dirname, 'templates', 'cv-template.html'),
  cv: join(__dirname, 'cv.md'),
  profileYml: join(__dirname, 'config', 'profile.yml'),
  profileMd: join(__dirname, 'modes', '_profile.md'),
  outputDir: join(__dirname, 'output'),
  generatePdfScript: join(__dirname, 'generate-pdf.mjs')
};

async function classifyTargetOpportunity(apiKey, companyName, roleTitle, jdText, modelName = DEFAULT_GEMINI_MODEL) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });

    const classificationPrompt = `
You are a hiring strategy analyzer. Given a company name, role title, and job description, classify the opportunity along three dimensions to optimize resume tailoring.

Target Company: ${companyName}
Target Role: ${roleTitle}
Job Description:
"""
${jdText}
"""

Return a JSON object in this format:
{
  "scale": "startup" | "mid-market" | "enterprise",
  "ecosystem": "salesforce-native" | "hybrid" | "modern-gtm-generalist",
  "titling": "specialist" | "generalist-builder"
}

Guidance:
1. "scale":
   - "startup": Early stage, fast-paced, Series A/B, or less than 500 employees. Focuses on velocity and zero-to-one builders.
   - "enterprise": Large corporate organizations, Fortune 500 (e.g., Salesforce, BlackRock, CVS, Albertsons). Focuses on governance, compliance, security, scale.
   - "mid-market": Mid-sized companies.
2. "ecosystem":
   - "salesforce-native": Roles specifically looking for a Salesforce developer/architect where the entire stack is Salesforce.
   - "modern-gtm-generalist": Roles looking for systems automation/GTM engineers working with tools like HubSpot, Clay, Claude, custom APIs, Python/Node, webhooks.
   - "hybrid": Salesforce roles that require integration with NetSuite, HubSpot, or external API platforms.
3. "titling":
   - "specialist": High-precision specialists (e.g. "Salesforce Application Architect").
   - "generalist-builder": Hands-on builder/engineer titles (e.g. "GTM Engineer", "Integration Developer").
`;

    const result = await model.generateContent(classificationPrompt);
    const text = result.response.text();
    return JSON.parse(text);
  } catch (err) {
    console.warn('⚠️ Opportunity classification failed, defaulting to enterprise/hybrid/specialist:', err.message);
    return {
      scale: 'enterprise',
      ecosystem: 'hybrid',
      titling: 'specialist'
    };
  }
}

async function generateTailoredCV(jdText, companyName, roleTitle) {
  // Resolve via the shared loader (env > config/runtime.json > unset) so a key
  // saved from the PWA Integrations tab is honored here, matching gemini-eval.mjs.
  const apiKey = resolveSetting('geminiApiKey', { root: __dirname });
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set (env, config/runtime.json, or .env file).');
  }
  // Same precedence for the model; falls back to the shared default when unset.
  const preferredModel = resolveSetting('geminiModel', { root: __dirname }) || DEFAULT_GEMINI_MODEL;

  console.log(`🤖 Classifying target opportunity (${companyName})...`);
  const classification = await classifyTargetOpportunity(apiKey, companyName, roleTitle, jdText, preferredModel);
  console.log(`📊 Classified target: Scale=${classification.scale}, Ecosystem=${classification.ecosystem}, Titling=${classification.titling}`);

  let dynamicDirectives = '';
  let selectedTemplatePath = PATHS.template;
  let useOnePageStyle = false;

  if (classification.scale === 'startup' || classification.ecosystem === 'modern-gtm-generalist' || process.argv.includes('--one-page') || process.env.FORCE_ONE_PAGE === 'true') {
    useOnePageStyle = true;
    selectedTemplatePath = join(__dirname, 'templates', 'resume-template.html');
    dynamicDirectives = `
- **Startup & Modern GTM Stack Directives (CRITICAL):**
  * **Generalize Salesforce Titles:** Rebrand candidate titles where appropriate. For example, change "Lead Salesforce Developer" to "Lead Integration Engineer" or "Lead GTM Systems Engineer" in the job titles list, to avoid looking ecosystem-locked.
  * **De-emphasize Platform Governance:** Avoid heavy enterprise terms like "release governance," "Force.com Security Reviews," "governor limits," "AppExchange rules," and "licensing compliance." Reframe them to general engineering terms: "API rate-limiting/request-throttling," "deployment velocity," "API security and data privacy," and "data pipeline architecture."
  * **Emphasize GTM Builder Profile:** Focus on custom integrations (REST APIs, webhooks, JSON data flows), automation logic, CRM data modeling (HubSpot/Salesforce mapping), and data enrichment pipelines (Clay, HubSpot workflow rules). Highlight hands-on prototyping and "zero-to-one" execution.
  * **Single Page Budgeting (HARD LIMIT):** To keep the resume strictly on ONE page, each work experience entry must have a MINIMUM of 2 bullet points and a MAXIMUM of 3 bullet points (focusing on the most impactful, metric-driven, and JD-aligned achievements). Do not list all bullets from the original CV. Focus on keeping the layout balanced so it fits exactly on one page without leaving excessive empty space at the bottom.
`;
  } else {
    dynamicDirectives = `
- **Enterprise & Salesforce Native Directives (CRITICAL):**
  * **Retain Salesforce Branding:** Keep candidate titles formal and Salesforce-centric (e.g., "Lead Salesforce Developer", "Sr. Salesforce Developer").
  * **Emphasize Platform Governance & Compliance:** Highlight "Force.com Security Reviews," "Salesforce Governor Limit mitigation," "sharing and security models," and "release governance (Copado, SFDX)."
  * **Highlight Certifications:** Make sure the certifications listed at the end are emphasized as a key differentiator.
`;
  }

  console.log('📄 Loading CV template and configurations...');
  const cvMd = readFileSync(PATHS.cv, 'utf-8');
  
  let profile = {};
  if (existsSync(PATHS.profileYml)) {
    try {
      profile = yaml.load(readFileSync(PATHS.profileYml, 'utf-8')) || {};
    } catch (e) {
      console.warn('Could not parse profile.yml:', e.message);
    }
  }

  const profileMd = existsSync(PATHS.profileMd) ? readFileSync(PATHS.profileMd, 'utf-8') : '';

  // Extract contact fields from profile
  const candidate = profile.candidate || {};
  const name = candidate.full_name || profile.name || 'Abhishek Tangudu';
  const phone = candidate.phone || profile.phone || '631-459-2907';
  const email = candidate.email || profile.email || 'abhishek.tangudu@outlook.com';
  const linkedinUrl = candidate.linkedin || profile.linkedin?.url || 'https://linkedin.com/in/abhi-t-62080426';
  const linkedinDisplay = candidate.linkedin ? candidate.linkedin.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : profile.linkedin?.display || 'linkedin.com/in/abhi-t-62080426';
  const portfolioUrl = candidate.portfolio_url || profile.portfolio?.url || 'https://www.salesforce.com/trailblazer/abhishektangudu';
  let portfolioDisplay = 'trailblazer/abhishektangudu';
  if (candidate.portfolio_url) {
    portfolioDisplay = candidate.portfolio_url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    if (portfolioDisplay.includes('salesforce.com/trailblazer/')) {
      portfolioDisplay = portfolioDisplay.replace('salesforce.com/trailblazer/', 'trailblazer/');
    }
  } else if (profile.portfolio?.display) {
    portfolioDisplay = profile.portfolio.display;
  }

  let location = candidate.location || (typeof profile.location === 'string' ? profile.location : null);
  if (!location) {
    if (profile.location && typeof profile.location === 'object') {
      const parts = [];
      if (profile.location.city) parts.push(profile.location.city);
      if (profile.location.country) parts.push(profile.location.country);
      location = parts.join(', ') || 'San Ramon, CA';
    } else {
      location = 'San Ramon, CA';
    }
  }

  if (!existsSync(selectedTemplatePath)) {
    console.warn(`⚠️ Selected template not found at ${selectedTemplatePath}, falling back to default template.`);
    selectedTemplatePath = PATHS.template;
    useOnePageStyle = false;
  }
  let templateHtml = readFileSync(selectedTemplatePath, 'utf-8');

  if (useOnePageStyle) {
    const cssOverrides = `
  /* Compact layout rules for single page budgeting */
  @page {
    margin: 0.45in 0.5in !important;
  }
  body {
    font-size: 9px !important;
    line-height: 1.3 !important;
  }
  .page {
    padding: 0px 0 !important;
  }
  .header {
    margin-bottom: 6px !important;
  }
  .header h1 {
    font-size: 20px !important;
    margin-bottom: 2px !important;
  }
  .header-gradient {
    height: 1.5px !important;
    margin-bottom: 4px !important;
  }
  .contact-row {
    font-size: 8.5px !important;
    gap: 2px 7px !important;
  }
  .section {
    margin-bottom: 8px !important;
  }
  .section-title {
    margin-bottom: 4px !important;
    padding-bottom: 1.5px !important;
    font-size: 10px !important;
  }
  .summary-text {
    font-size: 9px !important;
    line-height: 1.35 !important;
  }
  .competencies-grid {
    gap: 2px 5px !important;
  }
  .competency-tag {
    font-size: 8px !important;
    padding: 1.5px 5px !important;
  }
  .job {
    margin-bottom: 5px !important;
  }
  .job-header {
    margin-bottom: 0.5px !important;
  }
  .job-company {
    font-size: 10.5px !important;
  }
  .job-period {
    font-size: 8.5px !important;
  }
  .job-role {
    margin-bottom: 0.5px !important;
    font-size: 9px !important;
  }
  .job ul {
    margin-top: 0.5px !important;
    padding-left: 11px !important;
  }
  .job li {
    font-size: 8.5px !important;
    line-height: 1.3 !important;
    margin-bottom: 1.5px !important;
  }
  .project {
    margin-bottom: 4px !important;
  }
  .project-title {
    font-size: 9px !important;
  }
  .project-desc {
    font-size: 8.5px !important;
    line-height: 1.3 !important;
    margin-top: 0.5px !important;
  }
  .project-tech {
    font-size: 8px !important;
    margin-top: 0.5px !important;
  }
  .edu-item {
    margin-bottom: 2px !important;
    font-size: 8.5px !important;
  }
  .skills-grid {
    gap: 2px 6px !important;
  }
  .skill-item {
    font-size: 8.5px !important;
  }
  .skill-category {
    font-size: 8.5px !important;
  }
`;
    templateHtml = templateHtml.replace('</style>', cssOverrides + '\n</style>');
  }

  console.log(`🤖 Invoking Gemini to tailor CV for ${companyName} (${roleTitle})...`);

  const genAI = new GoogleGenerativeAI(apiKey);

  const prompt = `
You are an expert CV tailoring assistant. You will take the candidate's CV (in Markdown), their career configurations/archetypes, and a target Job Description (JD).
Your job is to tailor the CV content to maximize keyword alignment, relevance, and impact for this specific role, returning a JSON object that contains the replacements for the CV HTML template.

Target Company: ${companyName}
Target Role: ${roleTitle}

Target Job Description:
"""
${jdText}
"""

Candidate Original CV (cv.md):
"""
${cvMd}
"""

Candidate Profile / Archetypes (_profile.md):
"""
${profileMd}
"""

INSTRUCTIONS:
${dynamicDirectives}
- **CRITICAL GUARDRAIL: NEVER name or reference the Target Company, target role, or target project inside the CV text itself:** The resume must remain a general, standalone professional document. Do NOT use phrases like "aligning with Vapi's focus", "directly aligns with Vapi's focus", or "managing and optimizing Vapi's GTM tech stack." Frame these achievements neutrally (e.g., "aligning with advanced AI infrastructure and API platforms" or "managing high-growth GTM tech stacks"). Direct references to target companies, their specific products, or roles inside the CV content are strictly prohibited.
1. **Professional Summary (\`SUMMARY_TEXT\`):** Write a broad, high-level professional summary (3-4 lines). Emphasize the candidate's multi-cloud enterprise experience (Sales, Service, Commerce, Experience, and Revenue Clouds) and engineering leadership. Do NOT name specific technical terms (such as LWR, Apex, Aura, etc.) or certifications the candidate does not have (never claim they have a certification unless it is explicitly in their original CV). Keep the summary strategic and broad, bridging their career history to future leadership.
2. **Core Competencies (\`COMPETENCIES\`):** Select 6-8 key competency tags that match the JD's technical keywords and requirements. Format this as a single string of HTML tags, e.g.:
   \`<span class="competency-tag">GTM & Revenue Tech Stack</span>\\n<span class="competency-tag">AdTech & Order Management</span>\`
3. **Work Experience (\`EXPERIENCE\`):** Format the candidate's experience list in HTML. Under each job:
   - **Do not reorder or omit jobs:** You must preserve the exact chronological order of the jobs as listed in the original CV (cv.md). The list must remain in reverse-chronological order (from most recent to oldest: Albertsons Inc first, then Ampion, then CodeScience, then P2PSofttek entries).
   - Reorder experience bullet points to put the most JD-relevant achievements first.
   - Tailor the wording of bullet points to incorporate the exact vocabulary used in the JD (e.g., if JD mentions "REST API endpoints" and original CV says "integrations", adjust to "REST API endpoint integrations").
   - NEVER invent achievements; only reformulate existing ones ethically.
   - Use the following HTML structure for each job, and **always keep the full company name and client name intact exactly as written in cv.md** (e.g., "P2PSofttek LLC (Client: Salesforce)" or "P2PSofttek LLC (Client: G/O Digital)"). Do not strip or alter the client name:
     \`\`\`html
     <div class="job">
       <div class="job-header">
         <span class="job-company">Company Name (and Client name if applicable)</span>
         <span class="job-period">January 2026 – Present</span>
       </div>
       <div class="job-role">Role Title</div>
       <ul>
         <li>Tailored achievement bullet point 1</li>
         <li>Tailored achievement bullet point 2</li>
       </ul>
     </div>
     \`\`\`
4. **Projects (\`PROJECTS\`):** Select and tailor 2-3 most relevant projects from the candidate's portfolio. Use this HTML structure, mapping the client name to the project-badge span, and the technology list to the project-tech div:
     \`\`\`html
     <div class="project">
       <span class="project-title">Project Name</span>
       <span class="project-badge">Client or Company Name (e.g. Albertsons, Ampion, CodeScience, Salesforce)</span>
       <div class="project-desc">Tailored description mapping to JD skills.</div>
       <div class="project-tech">Tech: Comma-separated list of technologies used</div>
     </div>
     \`\`\`
5. **Skills (\`SKILLS\`):** Group skills into categories (e.g., Platforms, Languages, Tools) using this HTML structure:
     \`\`\`html
     <div class="skills-container">
       <div class="skill-group">
         <span class="skill-category">Category Name:</span>
         <span class="skill-list">Skill 1, Skill 2, Skill 3</span>
       </div>
     </div>
     \`\`\`

You must return a valid JSON object with the following keys:
- \`SUMMARY_TEXT\` (string, plain text summary)
- \`COMPETENCIES\` (string, raw HTML containing the span tags)
- \`EXPERIENCE\` (string, raw HTML containing the job blocks)
- \`PROJECTS\` (string, raw HTML containing the project blocks)
- \`SKILLS\` (string, raw HTML containing the skill blocks)

Ensure your JSON is valid and doesn't contain any syntax errors or markdown backticks outside of strings.
`;

  let responseText;
  let lastError = null;
  // preferredModel resolved above via the shared loader (env > runtime.json > default).
  const modelsToTry = [...new Set([
    preferredModel,
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash'
  ])];

  for (const currentModelName of modelsToTry) {
    console.log(`🤖  Trying model for CV tailoring: ${currentModelName}...`);
    try {
      const model = genAI.getGenerativeModel({
        model: currentModelName,
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
        }
      });
      const result = await model.generateContent(prompt);
      responseText = result.response.text();
      if (responseText) {
        console.log(`✅  Successfully tailored CV with model: ${currentModelName}`);
        break;
      }
    } catch (err) {
      lastError = err;
      const sanitizedMsg = (err.message || '').split(apiKey).join('[REDACTED]');
      console.warn(`⚠️   Model ${currentModelName} failed during CV tailoring: ${sanitizedMsg}`);
    }
  }

  if (!responseText) {
    const sanitizedMsg = (lastError?.message || 'Unknown error').split(apiKey).join('[REDACTED]');
    throw new Error(`Gemini API Error during CV tailoring: ${sanitizedMsg}`);
  }

  let tailoredData;
  try {
    tailoredData = JSON.parse(responseText.trim());
  } catch (parseErr) {
    console.error('Failed to parse Gemini JSON response. Raw output:\n', responseText);
    throw new Error('Gemini output was not valid JSON.');
  }

  // Handle static replacements
  const paperFormat = (profile.cv?.output_format === 'a4' || !['us', 'ca'].includes(location.split(',').pop().trim().toLowerCase())) ? 'a4' : 'letter';
  const pageWidth = paperFormat === 'a4' ? '210mm' : '8.5in';

  // Build the final replacements object
  const replacements = {
    '{{LANG}}': 'en',
    '{{PAGE_WIDTH}}': pageWidth,
    '{{NAME}}': name,
    '{{PHONE}}': phone,
    '{{EMAIL}}': email,
    '{{LINKEDIN_URL}}': linkedinUrl,
    '{{LINKEDIN_DISPLAY}}': linkedinDisplay,
    '{{PORTFOLIO_URL}}': portfolioUrl,
    '{{PORTFOLIO_DISPLAY}}': portfolioDisplay,
    '{{LOCATION}}': location,
    
    '{{SECTION_SUMMARY}}': 'Professional Summary',
    '{{SUMMARY_TEXT}}': tailoredData.SUMMARY_TEXT,
    
    '{{SECTION_COMPETENCIES}}': 'Core Competencies',
    '{{COMPETENCIES}}': tailoredData.COMPETENCIES,
    
    '{{SECTION_EXPERIENCE}}': 'Work Experience',
    '{{EXPERIENCE}}': tailoredData.EXPERIENCE,
    
    '{{SECTION_PROJECTS}}': 'Projects',
    '{{PROJECTS}}': tailoredData.PROJECTS || '',
    
    // We can extract education, certifications, and skills from cv.md
    '{{SECTION_EDUCATION}}': 'Education',
    '{{EDUCATION}}': `
      <div class="education-item">
        <div class="job-header">
          <span class="education-degree">Master of Science in Management Information Systems</span>
          <span class="job-period">Campbellsville University</span>
        </div>
      </div>
      <div class="education-item">
        <div class="job-header">
          <span class="education-degree">Master of Science in Computer Engineering</span>
          <span class="job-period">University of New Haven</span>
        </div>
      </div>
    `,
    
    '{{SECTION_CERTIFICATIONS}}': 'Certifications & Cohorts',
    '{{CERTIFICATIONS}}': `
      <table class="cert-table" style="width: 100%; border-collapse: collapse;">
        <tr><td>Salesforce Certified Application Architect</td></tr>
        <tr><td>Salesforce Certified Agentforce Specialist</td></tr>
        <tr><td>Salesforce Certified Revenue Cloud Consultant</td></tr>
        <tr><td>Salesforce Certified Platform Developer II / I</td></tr>
        <tr><td>Clay 101 Cohort (GTM Automation & Enrichment)</td></tr>
        <tr><td>Gumloop Cohort (LLM Orchestration & Agentic AI)</td></tr>
      </table>
    `,
    
    '{{SECTION_SKILLS}}': 'Skills',
    '{{SKILLS}}': tailoredData.SKILLS || `
      <div class="skills-container">
        <div class="skill-group">
          <span class="skill-category">Salesforce:</span>
          <span class="skill-list">Apex, LWC, Flow, Revenue Cloud (CPQ/Billing), Agentforce, CRM Analytics</span>
        </div>
      </div>
    `
  };

  // Perform replacements in template
  let photoReplacement = '';
  if (profile.candidate?.photo || profile.photo) {
    const photoSrc = profile.candidate?.photo || profile.photo;
    photoReplacement = `<img class="cv-photo" src="${photoSrc}" alt="${name}">`;
  }
  let finalHtml = templateHtml.replace(/^[ \t]*\{\{PHOTO\}\}[ \t]*\r?\n?/m, photoReplacement ? photoReplacement + '\n' : '');

  if (!tailoredData.PROJECTS || tailoredData.PROJECTS.trim() === '') {
    // Remove the entire projects section block from the template HTML
    finalHtml = finalHtml.replace(/<!-- PROJECTS -->[\s\S]*?<!-- EDUCATION -->/, '<!-- EDUCATION -->');
  }
  for (const [placeholder, val] of Object.entries(replacements)) {
    const formattedVal = typeof val === 'string' ? val.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') : val;
    finalHtml = finalHtml.split(placeholder).join(formattedVal);
  }

  // Create output directory if it doesn't exist
  if (!existsSync(PATHS.outputDir)) {
    mkdirSync(PATHS.outputDir, { recursive: true });
  }

  const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dateStr = new Date().toISOString().split('T')[0];
  const htmlFilename = `cv-tailored-${companySlug}.html`;
  const pdfFilename = `cv-tailored-${companySlug}-${dateStr}.pdf`;
  
  const htmlPath = join(PATHS.outputDir, htmlFilename);
  const pdfPath = join(PATHS.outputDir, pdfFilename);

  writeFileSync(htmlPath, finalHtml, 'utf-8');
  console.log(`✅ Tailored CV HTML written to ${htmlPath}`);

  // Compile PDF via Playwright generate-pdf.mjs
  console.log('📄 Compiling PDF via Playwright...');
  try {
    execFileSync(process.execPath, [PATHS.generatePdfScript, htmlPath, pdfPath, `--format=${paperFormat}`], {
      cwd: __dirname,
      encoding: 'utf-8',
      stdio: 'inherit'
    });
    console.log(`✅ Tailored CV PDF compiled successfully to ${pdfPath}`);
    return {
      htmlPath,
      pdfPath,
      pdfFilename
    };
  } catch (compileErr) {
    throw new Error(`Failed to compile tailored CV PDF: ${compileErr.message}`);
  }
}

// Support executing directly from command line if needed
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node generate-tailored-cv.mjs "<JD Text>" "<Company Name>" "<Role Title>"');
    process.exit(1);
  }
  generateTailoredCV(args[0], args[1], args[2])
    .then(res => console.log('Successfully completed tailoring CV! File:', res.pdfPath))
    .catch(err => console.error('Error tailoring CV:', err));
}

export { generateTailoredCV };
