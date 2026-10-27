const destination = new URL("https://app-tracking.sebastian-software.com/");
destination.hash = window.location.hash;
window.location.replace(destination.href);
