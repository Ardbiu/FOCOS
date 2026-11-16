// Entry point of the main page.
import './style.css';
import { startApp } from './app';
import { browserStorage, startIntro } from './intro';

// The intro first, so that on a first visit it covers the page before the app fills it.
startIntro(document, browserStorage(window));
startApp(document);
