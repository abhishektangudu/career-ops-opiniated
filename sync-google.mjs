// Dynamic import for googleapis to prevent crash when not installed
import fs from 'fs';
import path from 'path';

// Parse applications.md line
function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  
  // Extract clean report text or link
  let reportCell = parts[8];
  const linkMatch = reportCell.match(/\[(.*?)\]\((.*?)\)/);
  const reportText = linkMatch ? linkMatch[1] : reportCell;
  const reportLink = linkMatch ? linkMatch[2] : '';

  return [
    num,
    parts[2], // Date
    parts[3], // Company
    parts[4], // Role
    parts[5], // Score
    parts[6], // Status
    parts[7], // PDF Check (e.g. ✅ or ❌)
    reportText,
    reportLink,
    parts[9] || '' // Notes
  ];
}

// Parse scan-history.tsv line
function parseScanHistoryLine(line) {
  if (!line.trim()) return null;
  const parts = line.split('\t').map(s => s.trim());
  if (parts.length < 7) return null;
  return parts; // [url, first_seen, portal, title, company, status, location]
}

/**
 * Initialize Google APIs client
 */
let googleModule = null;
export async function getGoogleClients() {
  if (!googleModule) {
    try {
      googleModule = await import('googleapis');
    } catch (e) {
      throw new Error(`The 'googleapis' package is required for this integration but was not found. Please install it using 'npm install googleapis'. Error: ${e.message}`);
    }
  }
  const google = googleModule.google;
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/devstorage.read_write'
    ]
  });

  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
    storage: google.storage({ version: 'v1', auth })
  };
}

/**
 * Sync Applications Tracker markdown table to Google Sheets
 */
export async function syncTrackerToSheets(applicationsFilePath, spreadsheetId, sheetName = 'Applications', bucketName = '') {
  const { sheets } = await getGoogleClients();
  
  if (!fs.existsSync(applicationsFilePath)) {
    console.warn(`Tracker file not found at ${applicationsFilePath}, skipping Sheets sync.`);
    return;
  }

  const content = fs.readFileSync(applicationsFilePath, 'utf8');
  const lines = content.split('\n');
  const rows = [];

  // Add header row
  rows.push(['#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report Name', 'Report Path', 'Notes']);

  for (const line of lines) {
    const parsed = parseAppLine(line);
    if (parsed) {
      let [num, date, company, role, score, status, pdfEmoji, reportText, reportLink, notes] = parsed;

      // Rewrite reportLink to public GCS URL formula if bucketName is provided
      if (bucketName && reportLink && (reportLink.startsWith('../reports/') || reportLink.startsWith('reports/'))) {
        const filename = reportLink.substring(reportLink.lastIndexOf('/') + 1);
        const gcsReportUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
        reportLink = `=HYPERLINK("${gcsReportUrl}", "${reportText}")`;
      } else if (reportLink && reportLink.startsWith('http')) {
        // Wrap existing HTTP links in formulas
        reportLink = `=HYPERLINK("${reportLink}", "${reportText}")`;
      }

      // Rewrite PDF status emoji to public GCS URL formula if bucketName is provided and PDF is generated
      if (bucketName && pdfEmoji === '✅') {
        const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const pdfFilename = `cv-tailored-${companySlug}-${date}.pdf`;
        const gcsPdfUrl = `https://storage.googleapis.com/${bucketName}/${pdfFilename}`;
        pdfEmoji = `=HYPERLINK("${gcsPdfUrl}", "✅")`;
      }

      rows.push([
        num,
        date,
        company,
        role,
        score,
        status,
        pdfEmoji,
        reportText,
        reportLink,
        notes
      ]);
    }
  }

  // Ensure target sheet exists, or create it
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName
              }
            }
          }
        ]
      }
    });
    console.log(`Created sheet tab "${sheetName}" in Google Sheet.`);
  } catch (error) {
    // If sheet tab already exists, this is expected and we ignore the error
    if (!error.message.includes('already exists')) {
      throw error;
    }
  }

  // Overwrite the sheet tab with current applications
  // Clear existing content in the tab first
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A1:Z1000`
  });

  // Write new content
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: rows
    }
  });

  console.log(`Successfully synced ${rows.length - 1} applications to Google Sheet "${sheetName}".`);
  return response.data;
}

/**
 * Sync scan-history.tsv to Google Sheets
 */
export async function syncScanHistoryToSheets(scanHistoryFilePath, spreadsheetId, sheetName = 'Scan History') {
  const { sheets } = await getGoogleClients();

  if (!fs.existsSync(scanHistoryFilePath)) {
    console.warn(`Scan history file not found at ${scanHistoryFilePath}, skipping Sheets sync.`);
    return;
  }

  const content = fs.readFileSync(scanHistoryFilePath, 'utf8');
  const lines = content.split('\n');
  const rows = [];

  for (const line of lines) {
    const parsed = parseScanHistoryLine(line);
    if (parsed) {
      rows.push(parsed);
    }
  }

  if (rows.length === 0) return;

  // Ensure target sheet tab exists, or create it
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName
              }
            }
          }
        ]
      }
    });
    console.log(`Created sheet tab "${sheetName}" in Google Sheet.`);
  } catch (error) {
    if (!error.message.includes('already exists')) {
      throw error;
    }
  }

  // Overwrite the sheet tab
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A1:Z5000`
  });

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: rows
    }
  });

  console.log(`Successfully synced ${rows.length - 1} scan history entries to Google Sheet "${sheetName}".`);
  return response.data;
}

/**
 * Upload a file to Google Drive and retrieve its shareable link.
 * Updates the file in-place if it already exists in the folder to preserve the link.
 */
export async function uploadToDriveAndGetLink(fileName, filePath, folderId) {
  const { drive } = await getGoogleClients();

  if (!fs.existsSync(filePath)) {
    throw new Error(`File to upload not found at ${filePath}`);
  }

  const mimeType = fileName.endsWith('.pdf') ? 'application/pdf' : 'text/markdown';
  const media = {
    mimeType,
    body: fs.createReadStream(filePath)
  };

  // Check if file already exists in this folder to do an update
  let existingFileId = null;
  try {
    const query = `name = '${fileName}' and '${folderId}' in parents and trashed = false`;
    const searchRes = await drive.files.list({
      q: query,
      fields: 'files(id)'
    });
    if (searchRes.data.files && searchRes.data.files.length > 0) {
      existingFileId = searchRes.data.files[0].id;
    }
  } catch (err) {
    console.warn(`Error searching for existing file in Google Drive: ${err.message}`);
  }

  let response;
  if (existingFileId) {
    console.log(`Updating existing file in Google Drive (ID: ${existingFileId})...`);
    response = await drive.files.update({
      fileId: existingFileId,
      media: media,
      fields: 'id, webViewLink'
    });
  } else {
    console.log(`Uploading new file "${fileName}" to Google Drive...`);
    response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: mimeType
      },
      media: media,
      fields: 'id, webViewLink'
    });
  }

  const fileId = response.data.id;
  const webViewLink = response.data.webViewLink;

  // Make the file publicly viewable or visible to anyone with link (optional)
  // This is helpful if you want to access the link without needing to log in to the GService account's drive.
  try {
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  } catch (permErr) {
    // Sharing might fail if restricted by domain/corporate admin, ignore.
    console.warn(`Could not adjust sharing permissions: ${permErr.message}`);
  }

  return webViewLink;
}

/**
 * Upload a file to Google Cloud Storage (GCS) and retrieve its shareable link.
 */
export async function uploadToGcsAndGetLink(fileName, filePath, bucketName) {
  const { storage } = await getGoogleClients();

  if (!fs.existsSync(filePath)) {
    throw new Error(`File to upload not found at ${filePath}`);
  }

  const mimeType = fileName.endsWith('.pdf') ? 'application/pdf' : 'text/markdown';
  const media = {
    mimeType,
    body: fs.createReadStream(filePath)
  };

  console.log(`Uploading file "${fileName}" to GCS bucket "${bucketName}"...`);
  await storage.objects.insert({
    bucket: bucketName,
    name: fileName,
    media: media,
    predefinedAcl: 'publicRead'
  });

  const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
  return publicUrl;
}
