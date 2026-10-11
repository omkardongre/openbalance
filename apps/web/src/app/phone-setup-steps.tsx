/** How to put the setup code on the stall's phone. Same words the owner sees on their own page. */
export function PhoneSetupSteps() {
  return (
    <ol className="next-steps">
      <li>On the stall's phone, open the OpenBalance Terminal app.</li>
      <li>
        Tap <strong>⋮</strong> at the top right, then <strong>Scan setup code</strong>.
      </li>
      <li>Point the camera at the code. The phone checks in by itself.</li>
    </ol>
  );
}
