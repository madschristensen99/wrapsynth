// tabs.js
document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // remove active from all
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  
      // add active to current
      btn.classList.add("active");
      const tabId = btn.dataset.tab;
      document.getElementById(`${tabId}-tab`).classList.add("active");
    });
  });
  