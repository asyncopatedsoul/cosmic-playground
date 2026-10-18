/** A yes/no question over everything (custom sounds need an OK; leaving a room asks first). */
export function ask(question: string, yes: string, no: string): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "cst-ask";
    box.setAttribute("role", "alertdialog");
    box.innerHTML = `<p></p><div><button data-yes></button><button data-no></button></div>`;
    box.querySelector("p")!.textContent = question;
    box.querySelector("[data-yes]")!.textContent = yes;
    box.querySelector("[data-no]")!.textContent = no;
    document.body.append(box);
    const done = (answer: boolean) => {
      box.remove();
      removeEventListener("keydown", key, true);
      resolve(answer);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      done(false);
    };
    addEventListener("keydown", key, true);
    box.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) done(b.hasAttribute("data-yes"));
    });
    box.querySelector<HTMLButtonElement>("[data-yes]")!.focus();
  });
}
