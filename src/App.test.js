import { render, screen } from '@testing-library/react';
import App from './App';

test('renders FinTrack app without crashing', () => {
  render(<App />);
});