import dotenv from "dotenv"; // Load environment variables
dotenv.config();

import { google, sheets_v4 } from "googleapis";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import CREDENTIALS from "./credentials.json";

// Use Puppeteer Stealth Plugin
puppeteer.use(StealthPlugin());

// ✅ Load credentials from .env
const GOLF_AU_EMAIL = process.env.GOLF_AU_EMAIL || "";
const GOLF_AU_PASSWORD = process.env.GOLF_AU_PASSWORD || "";

if (!GOLF_AU_EMAIL || !GOLF_AU_PASSWORD) {
  console.error("❌ Missing Golf Australia credentials. Check your .env file.");
  process.exit(1);
}

// ✅ Define Types
interface RowData {
  row: number; // Google Sheets row number
  gaNumber: string; // GolfLink Number (from Column B)
  name: string; // Name (from Column A)
  handicap?: string; // Handicap value (from Column C)
  url?: string; // Profile URL (from Column D)
}

interface UpdateData {
  row: number; // Google Sheets row number
  handicap: string | null; // Scraped handicap value (Column C)
  url: string | null; // Profile URL (Column D)
}

// ✅ Sheet details
const SPREADSHEET_ID = "1WpH3IU2jGAmWnit4ihTUocxacbXRxbxkRQMTtc_-ivc"; // Replace with your Google Sheet ID
const RANGE = "Sheet1!A2:D"; // Columns A (Name), B (GolfLink), C (Handicap), D (URL)

// ✅ Google Sheets Authorization
async function authorizeGoogleSheets(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    credentials: CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  return sheets;
}

// ✅ Fetch GolfLink Numbers from Google Sheets
async function getGAValues(sheets: sheets_v4.Sheets): Promise<RowData[]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE,
  });

  const rows = response.data.values || [];
  // Filter out rows with empty GolfLink numbers
  return rows
    .map((row, index) => ({
      row: index + 2, // Google Sheets row number (starting from 2)
      name: row[0] || "", // Column A
      gaNumber: row[1] || "", // Column B
      handicap: row[2] || null, // Column C
      url: row[3] || null, // Column D
    }))
    .filter((row) => row.gaNumber); // Only include rows with non-empty GolfLink numbers
}

// ✅ Write Handicap and URL to Google Sheets
async function updateHandicap(
  sheets: sheets_v4.Sheets,
  updates: UpdateData[]
): Promise<void> {
  const data = updates.map(({ row, handicap, url }) => ({
    range: `Sheet1!C${row}:D${row}`,
    values: [[handicap, url]],
  }));

  if (data.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        data,
        valueInputOption: "USER_ENTERED",
      },
    });
  }
}

// ✅ Puppeteer Scraper Function with Auto-filled Login and Manual Submission
async function scrapeHandicaps(rows: RowData[]): Promise<UpdateData[]> {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const results: UpdateData[] = [];
  try {
    console.log("🚀 Navigating to login page...");
    const page = await browser.newPage();
    await page.goto("https://www.golf.org.au/login", { waitUntil: "domcontentloaded" });

    // ✅ Auto-fill Email & Password (but do NOT submit)
    console.log("🔑 Filling in login details...");
    await page.waitForSelector("#username");
    await page.type("#username", GOLF_AU_EMAIL, { delay: 100 });

    await page.waitForSelector("#password");
    await page.type("#password", GOLF_AU_PASSWORD, { delay: 100 });

    console.log("🛑 Please manually submit the form and solve CAPTCHA. Press ENTER in the terminal once logged in.");
    await new Promise((resolve) => process.stdin.once("data", resolve)); // Wait for user confirmation

    console.log("✅ Login detected! Proceeding with scraping...");

    for (const row of rows) {
      const { gaNumber, row: rowIndex } = row;

      try {
        const profileUrl = `https://www.golf.org.au/member/dashboard?golfLinkNo=${gaNumber}`;
        const scrapePage = await browser.newPage();
        await scrapePage.goto(profileUrl, { waitUntil: "domcontentloaded" });

        await scrapePage.waitForSelector(".Dashboardstyles__Handicap-l2htr4-5");

        const handicapValue = await scrapePage.$eval(
          ".Dashboardstyles__Handicap-l2htr4-5 .Dashboardstyles__Detail-l2htr4-11",
          (el) => el.textContent?.trim() || null
        );

        results.push({
          row: rowIndex,
          handicap: handicapValue,
          url: profileUrl,
        });

        await scrapePage.close();
      } catch (error) {
        console.error(`Failed to fetch data for GolfLink number ${gaNumber}:`, error);
        results.push({
          row: rowIndex,
          handicap: "Error",
          url: "",
        });
      }
    }
  } catch (error) {
    console.error("❌ Scraping error:", error);
  } finally {
    await browser.close();
  }

  return results;
}

// ✅ Main Function
async function main(): Promise<void> {
  const sheets = await authorizeGoogleSheets();

  console.log("📄 Fetching GolfLink numbers from Google Sheets...");
  const rows = await getGAValues(sheets);

  console.log("🔍 Starting Puppeteer to scrape data...");
  const scrapedData = await scrapeHandicaps(rows);

  console.log("📊 Updating Google Sheets with the scraped data...");
  await updateHandicap(sheets, scrapedData);

  console.log("✅ Google Sheets updated successfully!");
}

// ✅ Run the script
main().catch(console.error);
