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
