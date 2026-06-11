const fileInputs = document.querySelectorAll("input[type='file']");
const processingOverlay = document.querySelector("[data-processing-overlay]");
const processingTitle = document.querySelector("[data-processing-title]");
const processingMessage = document.querySelector("[data-processing-message]");
const confirmOverlay = document.querySelector("[data-confirm-overlay]");
const confirmMessage = document.querySelector("[data-confirm-message]");
const confirmCancel = document.querySelector("[data-confirm-cancel]");
const confirmRemove = document.querySelector("[data-confirm-remove]");

const processingCopy = {
  "save-single": {
    title: "Saving single page",
    message: "Fetching the page and embedding styles, images, icons, and CSS assets for offline reading."
  },
  "download-html": {
    title: "Preparing single HTML",
    message: "Creating one standalone HTML file. The download should begin shortly.",
    download: true
  },
  "download-zip": {
    title: "Preparing ZIP package",
    message: "Downloading page assets and packaging them with index.html. Larger pages can take longer.",
    download: true
  },
  "save-with-assets": {
    title: "Saving page with assets",
    message: "Fetching the page and storing its assets folder in your local webpocket library."
  },
  "save-optimized": {
    title: "Optimizing page",
    message: "Creating a smaller low-data reading copy by removing heavy page elements."
  },
  "download-optimized": {
    title: "Preparing optimized HTML",
    message: "Creating a smaller low-data HTML file. The download should begin shortly.",
    download: true
  },
  upload: {
    title: "Importing offline files",
    message: "Reading your selected HTML, ZIP, or assets folder and adding it to the local library."
  },
  remove: {
    title: "Removing saved page",
    message: "Deleting the saved files from local storage."
  },
  "preserve-assets": {
    title: "Importing browser-saved page",
    message: "Keeping the HTML file and its assets folder together for offline reading."
  },
  "single-html": {
    title: "Converting to single HTML",
    message: "Reading local assets from the saved browser folder and embedding them into one HTML file."
  }
};
let lastSubmitter = null;
let pendingConfirmForm = null;

fileInputs.forEach((input) => {
  input.addEventListener("change", () => {
    const label = input.closest("label")?.querySelector("[data-file-label]");
    if (!label) return;
    const count = input.files?.length || 0;
    label.textContent = count
      ? `${count} file${count === 1 ? "" : "s"} selected`
      : "Works with single HTML, optimized HTML, ZIP, or an assets folder.";
  });
});

function showProcessing(copy) {
  if (!processingOverlay) return;
  processingTitle.textContent = copy.title;
  processingMessage.textContent = copy.message;
  processingOverlay.hidden = false;
  document.body.classList.add("is-processing");
}

function hideProcessing() {
  if (!processingOverlay) return;
  processingOverlay.hidden = true;
  document.body.classList.remove("is-processing");
}

function addSubmitterValue(form, submitter) {
  if (!submitter?.name) return;
  const existing = form.querySelector(`input[type="hidden"][name="${submitter.name}"][data-submit-value]`);
  if (existing) existing.remove();
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = submitter.name;
  hidden.value = submitter.value;
  hidden.dataset.submitValue = "true";
  form.append(hidden);
}

function setControlsDisabled(form, disabled) {
  form.querySelectorAll("button, input").forEach((control) => {
    if (control.type === "hidden") return;
    if (disabled) {
      control.setAttribute("aria-disabled", "true");
    } else {
      control.removeAttribute("aria-disabled");
    }
  });
}

function submitAfterPaint(form) {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      HTMLFormElement.prototype.submit.call(form);
    }, 40);
  });
}

function openConfirmDialog(form, message) {
  if (!confirmOverlay || !confirmMessage || !confirmRemove) return false;
  pendingConfirmForm = form;
  confirmMessage.textContent = message;
  confirmOverlay.hidden = false;
  document.body.classList.add("is-confirming");
  confirmRemove.focus();
  return true;
}

function closeConfirmDialog() {
  if (!confirmOverlay) return;
  confirmOverlay.hidden = true;
  document.body.classList.remove("is-confirming");
  pendingConfirmForm = null;
}

confirmCancel?.addEventListener("click", closeConfirmDialog);

confirmOverlay?.addEventListener("click", (event) => {
  if (event.target === confirmOverlay) closeConfirmDialog();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirmOverlay && !confirmOverlay.hidden) {
    closeConfirmDialog();
  }
});

confirmRemove?.addEventListener("click", () => {
  if (!pendingConfirmForm) return;
  const form = pendingConfirmForm;
  form.dataset.confirmed = "true";
  closeConfirmDialog();
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    if (form.dispatchEvent(submitEvent)) {
      HTMLFormElement.prototype.submit.call(form);
    }
  }
});

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("click", (event) => {
    const button = event.target.closest("button[type='submit']");
    if (button && form.contains(button)) lastSubmitter = button;
  });

  form.addEventListener("submit", (event) => {
    if (form.dataset.submitting === "true") return;

    const confirmation = form.dataset.confirm;
    if (confirmation && form.dataset.confirmed !== "true") {
      event.preventDefault();
      openConfirmDialog(form, confirmation);
      return;
    }
    delete form.dataset.confirmed;

    const submitter = event.submitter || lastSubmitter;
    const action = form.action.includes("/delete")
      ? "remove"
      : submitter?.value || (form.enctype === "multipart/form-data" ? "upload" : "");
    const copy = processingCopy[action] || {
      title: "Processing",
      message: "Please wait while webpocket prepares your offline page."
    };

    event.preventDefault();
    addSubmitterValue(form, submitter);
    showProcessing(copy);
    setControlsDisabled(form, true);
    form.dataset.submitting = "true";
    submitAfterPaint(form);

    if (copy.download) {
      window.setTimeout(() => {
        hideProcessing();
        setControlsDisabled(form, false);
        delete form.dataset.submitting;
      }, 30000);
    }
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((registration) => {
      registration.update().catch(() => {});
    }).catch(() => {});
  });
}
