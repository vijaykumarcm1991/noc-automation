#!/usr/bin/env python3

import requests
import base64
import os
import sys
import csv
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from dotenv import load_dotenv
import smtplib
from email.message import EmailMessage
import zipfile

# All dates (report day, file names, log timestamps) are in IST.
IST = ZoneInfo(os.getenv("APP_TZ", "Asia/Kolkata"))

# =========================
# START TIME (NEW)
# =========================
start_time = datetime.now(IST)

# =========================
# LOGGING SETUP
# =========================
# Paths default to /var/scripts but can be overridden from the environment.
SCRIPTS_HOME = os.getenv("JSM_SCRIPTS_HOME", "/var/scripts")

log_dir = os.getenv("JSM_LOG_DIR", os.path.join(SCRIPTS_HOME, "logs"))
os.makedirs(log_dir, exist_ok=True)

log_file = f"{log_dir}/jsm_daily_report.log"

logger = logging.getLogger("JSM_DAILY_REPORT")
logger.setLevel(logging.INFO)

handler = RotatingFileHandler(log_file, maxBytes=5*1024*1024, backupCount=3)
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
formatter.converter = lambda *args: datetime.now(IST).timetuple()
handler.setFormatter(formatter)

# Also log to stdout so the automation tool's run history captures the output.
console = logging.StreamHandler(sys.stdout)
console.setFormatter(formatter)

if not logger.handlers:
    logger.addHandler(handler)
    logger.addHandler(console)

# =========================
# LOAD ENV
# =========================
# Values already in the environment (e.g. vault secrets) take precedence.
load_dotenv(os.getenv("JSM_ENV_FILE", os.path.join(SCRIPTS_HOME, ".env")))

# JSM_USER and JSM_TOKEN are injected as environment variables by the
# automation tool's secrets vault (secret name == env var name).
BASE_URL = os.getenv("JSM_BASE_URL")
EMAIL = os.getenv("JSM_USER")
API_TOKEN = os.getenv("JSM_TOKEN")

if not all([BASE_URL, EMAIL, API_TOKEN]):
    logger.error("Missing environment variables")
    raise ValueError("Missing environment variables")

# =========================
# AUTH
# =========================
auth_str = f"{EMAIL}:{API_TOKEN}"
b64_auth = base64.b64encode(auth_str.encode()).decode()

headers = {
    "Authorization": f"Basic {b64_auth}",
    "Accept": "application/json"
}

# =========================
# API
# =========================
url = f"{BASE_URL.rstrip('/')}/rest/api/3/search/jql"

# (connect, read) timeout in seconds for each Jira request.
REQUEST_TIMEOUT = (10, int(os.getenv("JSM_REQUEST_TIMEOUT", 60)))

# =========================
# JQL (DAILY REPORT)
# =========================
jql = 'issuetype = Incident AND created >= startOfDay(-1) AND created < startOfDay() ORDER BY created ASC'

# =========================
# FIELDS
# =========================
fields = [
    "key","issuetype","customfield_10086","customfield_10085","status","priority",
    "summary","customfield_10093","assignee","created","updated","resolutiondate",
    "customfield_10108","customfield_10106","customfield_10092","customfield_10097",
    "customfield_10091","customfield_10099","customfield_10094","customfield_10096",
    "customfield_10098","aggregatetimespent","customfield_10142","customfield_10130",
    "customfield_10144","customfield_10146","customfield_10126","customfield_10156",
    "customfield_10105","customfield_10103","customfield_10104","customfield_10138",
    "customfield_10095","customfield_10102","customfield_10117","customfield_10114",
    "customfield_10115","customfield_10113","customfield_10118"
]

# =========================
# HELPERS
# =========================
def format_date(date_str):
    if not date_str:
        return ""
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%dT%H:%M:%S.%f%z')
        return dt.astimezone(IST).strftime('%Y-%m-%d %H:%M:%S')
    except (ValueError, TypeError):
        logger.warning(f"Date parsing failed: {date_str}")
        return date_str

def get_value(field):
    if isinstance(field, dict):
        return field.get("value") or field.get("displayName") or field.get("name")
    return field if field else ""

def extract_adf_text(adf):
    try:
        if not adf or "content" not in adf:
            return ""

        texts = []
        for block in adf.get("content", []):
            for item in block.get("content", []):
                if item.get("type") == "text":
                    texts.append(item.get("text", ""))

        return " ".join(texts)
    except Exception as e:
        logger.warning(f"ADF parsing failed: {str(e)}")
        return str(adf)

# =========================
# PAGINATION (nextPageToken)
# =========================
next_page_token = None
all_issues = []

logger.info("Starting JSM data fetch...")

while True:
    params = {
        "jql": jql,
        "fields": ",".join(fields),
        "maxResults": 100
    }

    if next_page_token:
        params["nextPageToken"] = next_page_token

    try:
        response = requests.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        logger.error(f"API request failed: {e}")
        raise

    if response.status_code != 200:
        logger.error(f"API failed: {response.status_code} - {response.text[:500]}")
        raise RuntimeError(f"Jira API returned HTTP {response.status_code}")

    data = response.json()

    issues = data.get("issues", [])
    next_page_token = data.get("nextPageToken")

    logger.info(f"Fetched {len(issues)} issues | nextPageToken={next_page_token}")

    if not issues:
        break

    all_issues.extend(issues)

    if not next_page_token:
        break

logger.info(f"Total issues fetched: {len(all_issues)}")

# =========================
# CSV HEADERS
# =========================
csv_headers = [
    "Key","Issue Type","Unit","Application","Status","Priority","Summary",
    "Summary Details","Assignee","Created","Updated","Resolved",
    "Response SLA","Resolution SLA","Site_Location","Geography","Country",
    "Infra_App","Affected_CI","Issue_Category","Owner_Name","Σ Time Spent",
    "Assigned Date Bot","Escalation Date L2","Assigned Date L2",
    "Escalation Date L3","Security Incident","Security Incident Comment",
    "Fault Attribution","Closure Code","Resolved By(Team)","Last Level Assignee",
    "Source","Call Summary","Reason for Missed Resolution SLA","Expected Response Date/Time",
    "Expected Resolution Date/Time","Service(s)","Service Impact"
]

rows = []

# =========================
# DATA PROCESSING
# =========================
for issue in all_issues:
    f = issue.get("fields", {})

    row = [
        issue.get("key"),
        get_value(f.get("issuetype")),
        get_value(f.get("customfield_10086")),
        get_value(f.get("customfield_10085")),
        get_value(f.get("status")),
        get_value(f.get("priority")),
        f.get("summary"),
        extract_adf_text(f.get("customfield_10093")),
        get_value(f.get("assignee")),
        format_date(f.get("created")),
        format_date(f.get("updated")),
        format_date(f.get("resolutiondate")),
        get_value(f.get("customfield_10108")),
        get_value(f.get("customfield_10106")),
        f.get("customfield_10092"),
        get_value(f.get("customfield_10097")),
        get_value(f.get("customfield_10091")),
        get_value(f.get("customfield_10099")),
        f.get("customfield_10094"),
        get_value(f.get("customfield_10096")),
        f.get("customfield_10098"),
        f.get("aggregatetimespent"),
        format_date(f.get("customfield_10142")),
        format_date(f.get("customfield_10130")),
        format_date(f.get("customfield_10144")),
        format_date(f.get("customfield_10146")),
        get_value(f.get("customfield_10126")),
        f.get("customfield_10156"),
        get_value(f.get("customfield_10105")),
        get_value(f.get("customfield_10103")),
        get_value(f.get("customfield_10104")),
        get_value(f.get("customfield_10138")),
        get_value(f.get("customfield_10095")),
        f.get("customfield_10102"),
        get_value(f.get("customfield_10117")),
        format_date(f.get("customfield_10114")),
        format_date(f.get("customfield_10115")),
        get_value(f.get("customfield_10113")),
        get_value(f.get("customfield_10118"))
    ]

    rows.append(row)

# =========================
# FILE NAME
# =========================
output_dir = os.getenv("JSM_OUTPUT_DIR", os.path.join(SCRIPTS_HOME, "jsm_daily"))
os.makedirs(output_dir, exist_ok=True)

yesterday = datetime.now(IST) - timedelta(days=1)
yesterday_date = yesterday.strftime("%d%b%Y")

csv_path = os.path.join(output_dir, f"JSM_Daily_Report_{yesterday_date}.csv")

# =========================
# WRITE CSV + ZIP + EMAIL
# =========================
email_failed = False

try:
    # Write CSV
    with open(csv_path, mode="w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(csv_headers)
        writer.writerows(rows)

    logger.info(f"CSV generated successfully: {csv_path}")
    logger.info(f"Execution completed successfully | Records: {len(all_issues)}")

    # =========================
    # CREATE ZIP FILE
    # =========================
    zip_path = csv_path.replace(".csv", ".zip")

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        zipf.write(csv_path, os.path.basename(csv_path))

    logger.info(f"ZIP file created: {zip_path}")

    # =========================
    # EMAIL CONFIG
    # =========================
    SMTP_SERVER = os.getenv("SMTP_SERVER")
    SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
    SMTP_EMAIL = os.getenv("SMTP_EMAIL")
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
    EMAIL_TO = os.getenv("EMAIL_TO")

    if not all([SMTP_SERVER, SMTP_EMAIL, SMTP_PASSWORD, EMAIL_TO]):
        logger.warning("Email config missing. Skipping email sending.")
    else:
        recipients = [email.strip() for email in EMAIL_TO.split(",")]

        msg = EmailMessage()
        msg["Subject"] = f"JSM Daily Report - {yesterday_date}"
        msg["From"] = SMTP_EMAIL
        msg["To"] = ", ".join(recipients)

        msg.set_content(f"""
Hi Team,

Please find attached JSM Daily Report (zipped) for {yesterday_date}.

Total Records: {len(all_issues)}

Regards,
NOC - Report Automation
""")

        # =========================
        # ATTACH ZIP FILE
        # =========================
        with open(zip_path, "rb") as f:
            msg.add_attachment(
                f.read(),
                maintype="application",
                subtype="zip",
                filename=os.path.basename(zip_path)
            )

        # =========================
        # SEND EMAIL
        # =========================
        try:
            with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=60) as server:
                server.starttls()
                server.login(SMTP_EMAIL, SMTP_PASSWORD)
                server.send_message(msg)

            logger.info("Email sent successfully with ZIP attachment")

            # =========================
            # DELETE ZIP AFTER SEND
            # =========================
            os.remove(zip_path)
            logger.info(f"ZIP file deleted after email: {zip_path}")

        except Exception as e:
            email_failed = True
            logger.error(f"Email sending failed: {str(e)}")

except Exception as e:
    logger.error(f"CSV/ZIP/Email process failed: {str(e)}")
    raise

# =========================
# EXECUTION TIME (NEW)
# =========================
end_time = datetime.now(IST)
duration = (end_time - start_time).total_seconds()

logger.info(f"Execution time: {duration} seconds")

# A report that never reached its recipients is a failed run.
if email_failed:
    logger.error("Report generated but email delivery failed; exiting with error")
    sys.exit(1)
