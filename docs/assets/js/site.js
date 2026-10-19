/* Bridlewise docs — theme and navigation. No dependencies, no network. */
(function () {
  "use strict";

  var root = document.documentElement;
  var themeButton = document.querySelector("[data-theme-toggle]");
  var themeLabel = document.querySelector("[data-theme-label]");
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  var navButton = document.querySelector("[data-nav-toggle]");
  var navLabel = document.querySelector(".nav-toggle-label");
  var body = document.body;

  function currentTheme() {
    return root.dataset.theme === "logbook" ? "logbook" : "carbon";
  }

  function paintThemeControls() {
    if (!themeButton) return;
    var next = currentTheme() === "logbook" ? "carbon" : "logbook";
    var nextName = next === "logbook" ? "logbook" : "carbon";
    if (themeLabel) themeLabel.textContent = nextName.charAt(0).toUpperCase() + nextName.slice(1);
    themeButton.setAttribute("aria-label", "Switch to " + nextName + " theme");
    if (themeMeta) themeMeta.setAttribute("content", currentTheme() === "logbook" ? "#f4f0e6" : "#101216");
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    try {
      localStorage.setItem("bridlewise-theme", theme);
    } catch (error) {}
    paintThemeControls();
  }

  if (themeButton) {
    paintThemeControls();
    themeButton.addEventListener("click", function () {
      setTheme(currentTheme() === "logbook" ? "carbon" : "logbook");
    });
  }

  function setNav(open, returnFocus) {
    if (!navButton) return;
    body.classList.toggle("nav-open", open);
    navButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (navLabel) navLabel.textContent = open ? "Close" : "Menu";
    if (open) {
      var first = document.querySelector("#site-nav a");
      if (first) first.focus();
    } else if (returnFocus) {
      navButton.focus();
    }
  }

  // GitHub renders `> [!WARNING]` as an alert; Jekyll does not. Strip the
  // marker from the first text node and tag the blockquote so the static site
  // keeps the same intent as the Markdown on GitHub.
  var article = document.querySelector(".article");
  if (article) {
    var quotes = article.querySelectorAll("blockquote");
    for (var q = 0; q < quotes.length; q += 1) {
      var firstParagraph = quotes[q].querySelector("p");
      if (!firstParagraph) continue;
      var walker = document.createTreeWalker(firstParagraph, NodeFilter.SHOW_TEXT, null);
      var node = walker.nextNode();
      if (!node) continue;
      var match = node.nodeValue.match(/^\[!(WARNING|NOTE|TIP|IMPORTANT|CAUTION)\]\s*/);
      if (!match) continue;
      node.nodeValue = node.nodeValue.slice(match[0].length);
      quotes[q].className += " callout callout-" + match[1].toLowerCase();
    }
  }

  if (navButton) {
    navButton.addEventListener("click", function () {
      setNav(!body.classList.contains("nav-open"), false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && body.classList.contains("nav-open")) {
        setNav(false, true);
      }
    });

    var navLinks = document.querySelectorAll("#site-nav a");
    for (var i = 0; i < navLinks.length; i += 1) {
      navLinks[i].addEventListener("click", function () {
        if (window.matchMedia("(max-width: 960px)").matches) setNav(false, false);
      });
    }

    window.addEventListener("resize", function () {
      if (window.innerWidth > 960 && body.classList.contains("nav-open")) {
        setNav(false, false);
      }
    });
  }
})();

/* Command-palette search over the static page index. No network beyond the
   site's own /search.json; no dependencies, no tracking. */
(function () {
  "use strict";

  var dialog = document.querySelector("[data-search-dialog]");
  if (!dialog || typeof dialog.showModal !== "function") return;
  var input = dialog.querySelector("[data-search-input]");
  var status = dialog.querySelector("[data-search-status]");
  var list = dialog.querySelector("[data-search-results]");
  var openers = document.querySelectorAll("[data-search-open]");
  var index = null;
  var loading = false;
  var filtered = [];
  var active = 0;

  function isTyping(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function loadIndex() {
    if (index !== null || loading) return Promise.resolve(index);
    loading = true;
    return fetch(dialog.dataset.searchUrl, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("search index unavailable");
        return response.json();
      })
      .then(function (data) {
        index = Array.isArray(data) ? data : [];
        return index;
      })
      .catch(function () {
        index = [];
        return index;
      })
      .finally(function () {
        loading = false;
      });
  }

  function render() {
    var query = input.value.trim().toLowerCase();
    var source = index || [];
    if (query.length === 0) {
      filtered = source.slice(0, 8);
    } else {
      filtered = source.filter(function (entry) {
        return (entry.title + " " + (entry.description || "")).toLowerCase().indexOf(query) !== -1;
      }).slice(0, 20);
    }
    active = 0;
    list.textContent = "";
    if (filtered.length === 0) {
      status.textContent = source.length === 0 ? "The index is unavailable. Use the footer links." : "No match in the record. Try a broader word.";
      return;
    }
    status.textContent = query.length === 0
      ? "Start with these pages, or type to search " + source.length + " entries."
      : filtered.length + " match" + (filtered.length === 1 ? "" : "es") + " in the record.";
    filtered.forEach(function (entry, position) {
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = entry.url;
      link.className = "search-result";
      link.dataset.index = String(position);
      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = entry.title;
      var description = document.createElement("span");
      description.className = "search-result-description";
      description.textContent = entry.description || entry.url;
      link.appendChild(title);
      link.appendChild(description);
      item.appendChild(link);
      list.appendChild(item);
    });
    paintActive();
  }

  function paintActive() {
    var links = list.querySelectorAll(".search-result");
    for (var i = 0; i < links.length; i += 1) {
      var selected = i === active;
      links[i].classList.toggle("is-active", selected);
      links[i].setAttribute("aria-selected", selected ? "true" : "false");
    }
    if (links[active]) links[active].scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (dialog.open) return;
    dialog.showModal();
    document.body.classList.add("search-open");
    loadIndex().then(render);
    input.value = "";
    input.focus();
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    document.body.classList.remove("search-open");
  }

  for (var i = 0; i < openers.length; i += 1) openers[i].addEventListener("click", open);
  dialog.querySelector("[data-search-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", function () { document.body.classList.remove("search-open"); });
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) close();
  });
  input.addEventListener("input", render);
  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
      paintActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      paintActive();
    } else if (event.key === "Enter" && filtered[active]) {
      event.preventDefault();
      window.location.href = filtered[active].url;
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && !isTyping(event.target)) {
      event.preventDefault();
      open();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    }
  });
})();

/* Copy buttons on code blocks. Progressive enhancement: the code remains
   selectable and readable if the Clipboard API is unavailable. */
(function () {
  "use strict";
  var blocks = document.querySelectorAll("pre");
  if (!blocks.length) return;
  for (var i = 0; i < blocks.length; i += 1) {
    (function (pre) {
      var code = pre.querySelector("code");
      if (!code) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");
      button.addEventListener("click", function () {
        var text = code.innerText;
        var done = function () {
          button.textContent = "Copied";
          button.classList.add("is-copied");
          window.setTimeout(function () {
            button.textContent = "Copy";
            button.classList.remove("is-copied");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { button.textContent = "Select"; });
        } else {
          var range = document.createRange();
          range.selectNodeContents(code);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          button.textContent = "Select";
        }
      });
      pre.appendChild(button);
    })(blocks[i]);
  }
})();
