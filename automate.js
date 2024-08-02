const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const moment = require("moment");
const Tesseract = require('tesseract.js');

const config = require("./config.json");

const logFilePath = path.join(__dirname, "error.log");

async function logError(message) {
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${message}\n`);
}

async function recognizeText(imagePath) {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
    return text;
  } catch (error) {
    console.error("Error recognizing text:", error.message);
    await logError(`Error recognizing text: ${error.message}\nStack: ${error.stack}`);
    return "";
  }
}

function getNextMeetingWaitDuration(eventTimes) {
  const currentTime = moment();
  const meetingTimes = eventTimes.map(timeRange => {
    const [startTime, endTime] = timeRange.split(' - ').map(time => moment(time, 'hh:mm A'));
    return { startTime, endTime };
  });

  const upcomingMeeting = meetingTimes.find(meeting => currentTime.isBefore(meeting.startTime));
  if (upcomingMeeting) {
    const timeUntilMeeting = upcomingMeeting.startTime.diff(currentTime);
    return timeUntilMeeting > 0 ? timeUntilMeeting : 0;
  }

  const firstMeetingTomorrow = moment(eventTimes[0].split(' - ')[0], 'hh:mm A').add(1, 'day');
  const timeUntilFirstMeetingTomorrow = firstMeetingTomorrow.diff(currentTime);
  return timeUntilFirstMeetingTomorrow;
}

async function runAutomation(browser) {
  let page;
  
  try {
    if (!page) {
      page = await browser.newPage();
    } else {
      await page.bringToFront();
    }

    console.log("Navigating to the URL...");
    await page.goto(config.portalUrl, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    console.log("Page loaded. Taking screenshot before interaction...");
    await page.screenshot({ path: "3.png" });

    console.log("Accessing outer iframe...");
    const outerIframeElement = await page.waitForSelector("#unit-iframe");
    const outerIframe = await outerIframeElement.contentFrame();

    console.log("Accessing inner iframe...");
    const innerIframeElement = await outerIframe.waitForSelector(
      'iframe[src*="https://lithan.teams.sambaash.com/calendar/"]'
    );
    const innerIframe = await innerIframeElement.contentFrame();

    console.log("Waiting for dropdown button inside inner iframe...");
    await innerIframe.waitForSelector('button[data-id="calendarpicker"]', {
      visible: true
    });
    console.log("Dropdown button found. Clicking...");
    await innerIframe.click('button[data-id="calendarpicker"]', {
      force: true
    });
    console.log("Clicked dropdown button.");

    console.log("Waiting for dropdown menu...");
    await innerIframe.waitForSelector("div.dropdown-menu.show", {
      visible: true
    });
    console.log("Dropdown menu is visible.");
    await page.screenshot({ path: "1.png" });

    console.log('Waiting for "Day" option...');
    await innerIframe.waitForSelector("a#bs-select-1-3", { visible: true });
    console.log('"Day" option found. Clicking...');
    await innerIframe.click("a#bs-select-1-3", { force: true });
    console.log('Selected "Day" from the dropdown.');
    await page.screenshot({ path: "2.png" });

    console.log("Getting current local time...");
    const currentTime = moment();
    console.log(`Current time: ${currentTime.format("hh:mm A")}`);

    console.log("Finding the event matching the current time...");
    const events = await innerIframe.$$eval("a.fc-daygrid-event", (nodes) => {
      return nodes.map((node) => {
        const timeText = node.querySelector(".fc-event-time").textContent.trim();
        const [start, end] = timeText.split(" - ");
        const title = node.querySelector(".fc-event-title").textContent.trim();
        const href = node.getAttribute("href");

        return {
          href: href,
          startTime: start,
          endTime: end,
          title: title
        };
      });
    });

    console.log("Events:", events);

    const matchingEvent = events.find((event) => {
      const eventStartTime = moment(event.startTime, "hh:mm A");
      const eventEndTime = moment(event.endTime, "hh:mm A");
      console.log(
        `Comparing event: ${event.title} (${event.startTime} - ${event.endTime})`
      );
      return currentTime.isBetween(eventStartTime.subtract(5, 'minutes'), eventEndTime);
    });

    if (matchingEvent) {
      console.log(`Found matching event: ${matchingEvent.title}`);

      console.log("Clicking the event link...");
      await innerIframe.evaluate((href) => {
        const eventElement = document.querySelector(`a[href="${href}"]`);
        if (eventElement) {
          eventElement.scrollIntoView();
          eventElement.click();
        } else {
          console.log("Event element not found");
        }
      }, matchingEvent.href);
      await page.screenshot({ path: "4.png" });

      console.log("Waiting for modal to appear...");
      try {
        await innerIframe.waitForSelector("#notification", {
          visible: true,
          timeout: 60000 // Increased timeout
        });
        console.log("Modal appeared. Clicking join button...");
        await innerIframe.click("#notification-join");
        console.log("Clicked join button.");

        const newPagePromise = new Promise((resolve) =>
          browser.once("targetcreated", async (target) => {
            const newPage = await target.page();
            resolve(newPage);
          })
        );
        const newPage = await newPagePromise;

        console.log('Taking screenshot of the new page...');
        await newPage.screenshot({ path: "new-page.png" });

        console.log('Recognizing text on the new page...');
        const text = await recognizeText("new-page.png");
        console.log(`Recognized text: ${text}`);

        console.log('Waiting for "Continue on this browser" button...');
        await newPage.waitForSelector('button[data-tid="joinOnWeb"]', { visible: true });

        console.log('"Continue on this browser" button found. Clicking...');
        await newPage.evaluate(() => {
          const button = document.querySelector('button[data-tid="joinOnWeb"]');
          if (button) {
            button.click();
          }
        });
        console.log('Clicked "Continue on this browser" button.');

        console.log('Waiting for "Join now" button...');
        await newPage.waitForSelector('button#prejoin-join-button', { visible: true });

        console.log('"Join now" button found. Clicking...');
        await newPage.evaluate(() => {
          const joinButton = document.querySelector('button#prejoin-join-button');
          if (joinButton) {
            joinButton.click();
          }
        });
        console.log('Clicked "Join now" button.');

        // Handle muting the microphone here if needed
        console.log("Waiting for microphone button...");
        await newPage.waitForSelector('button#microphone-button', { visible: true });
        const isMicMuted = await newPage.evaluate(() => {
          const micButton = document.querySelector('button#microphone-button');
          return micButton && micButton.getAttribute('aria-label').includes('Unmute mic');
        });

        if (!isMicMuted) {
          console.log("Mic is not muted. Muting...");
          await newPage.click('button#microphone-button');
        }

      } catch (error) {
        console.error(
          "Error waiting for modal or clicking join button:",
          error.message
        );
        await logError(
          `Error waiting for modal or clicking join button: ${error.message}\nStack: ${error.stack}`
        );
      }
    } else {
      console.log("No matching event found.");
    }
  } catch (error) {
    console.error("Error:", error.message);
    await logError(`Error: ${error.message}\nStack: ${error.stack}`);
  }
}

(async () => {
  let browser;

  try {
    while (true) {
      try {
        if (browser && !browser.isClosed()) {
          console.log("Closing all browser tabs...");
          const pages = await browser.pages();
          for (const page of pages) {
            if (page.url() === 'about:blank') {
              await page.close();
            }
            await page.close();
          }
          console.log("All tabs closed.");
          await browser.close();
        }

        browser = await puppeteer.launch({
          headless: false,
          devtools: false,
          userDataDir: config.userDataDir,
          executablePath: config.chromeExecutablePath,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            '--no-protocol-handler',
            "--window-size=1920,1080"
          ],
          defaultViewport: null
        });

        await runAutomation(browser);
      } catch (error) {
        console.error("Error during automation run:", error.message);
        await logError(`Error during automation run: ${error.message}\nStack: ${error.stack}`);
      }

      const checkInterval = getNextMeetingWaitDuration(config.eventTimes);
      console.log(`Waiting for ${moment.duration(checkInterval).humanize()} before next run...`);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  } catch (error) {
    console.error("Error launching browser:", error.message);
    await logError(`Error launching browser: ${error.message}\nStack: ${error.stack}`);
  }
})();
