require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios');
const nodeCron = require('node-cron');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.json());

// Database connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/weatherAlerts', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Subscriber model
const subscriberSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  district: { type: String, required: true },
  city: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Subscriber = mongoose.model('Subscriber', subscriberSchema);

// Twilio client setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Visual Crossing Weather API configuration
const VC_API_KEY = process.env.VC_API_KEY || 'DJQ2CNMD97ZCW68YN3YSSJ9CW';
const VC_BASE_URL = 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline';

// Helper function to fetch weather data
async function fetchWeatherData(location) {
  try {
    const response = await axios.get(`${VC_BASE_URL}/${location}`, {
      params: {
        unitGroup: 'us',
        key: VC_API_KEY,
        contentType: 'json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error fetching weather data:', error.response?.data || error.message);
    throw new Error('Failed to fetch weather data');
  }
}

// Process current conditions from API response
function processCurrentConditions(data) {
  const current = data.currentConditions;
  return {
    temp: current.temp,
    feelslike: current.feelslike,
    humidity: current.humidity,
    windspeed: current.windspeed,
    winddir: current.winddir,
    pressure: current.pressure,
    uvindex: current.uvindex,
    visibility: current.visibility,
    conditions: current.conditions,
    icon: current.icon,
    sunrise: data.days[0].sunrise,
    sunset: data.days[0].sunset,
    precip: current.precip,
    snow: current.snow
  };
}

// Process hourly forecast data
function processHourlyForecast(hourlyData) {
  return hourlyData.map(hour => ({
    time: new Date(hour.datetimeEpoch * 1000).toLocaleTimeString([], { hour: '2-digit' }),
    temp: hour.temp,
    feelslike: hour.feelslike,
    humidity: hour.humidity,
    precip: hour.precip,
    precipProb: hour.precipprob,
    windspeed: hour.windspeed,
    winddir: hour.winddir,
    conditions: hour.conditions,
    icon: hour.icon
  }));
}

// Process daily forecast data
function processDailyForecast(dailyData) {
  return dailyData.map(day => ({
    date: new Date(day.datetimeEpoch * 1000).toLocaleDateString('en-IN', { 
      weekday: 'long', 
      month: 'short', 
      day: 'numeric' 
    }),
    tempmax: day.tempmax,
    tempmin: day.tempmin,
    temp: day.temp,
    feelslike: day.feelslike,
    humidity: day.humidity,
    precip: day.precip,
    precipProb: day.precipprob,
    windspeed: day.windspeed,
    winddir: day.winddir,
    conditions: day.conditions,
    icon: day.icon,
    sunrise: day.sunrise,
    sunset: day.sunset,
    description: day.description
  }));
}

// API endpoint to get weather data
app.get('/api/weather', async (req, res) => {
  try {
    const { city, district } = req.query;
    
    if (!city || !district) {
      return res.status(400).json({ error: 'City and district are required' });
    }

    // Try with city name first, then fallback to district
    let location = `${city},Tamil Nadu,India`;
    let weatherData = await fetchWeatherData(location);
    
    // If not found, try with district name
    if (!weatherData || weatherData.errorCode) {
      location = `${district},Tamil Nadu,India`;
      weatherData = await fetchWeatherData(location);
    }

    if (!weatherData || weatherData.errorCode) {
      return res.status(404).json({ error: 'Location not found' });
    }

    const responseData = {
      address: weatherData.resolvedAddress,
      currentConditions: processCurrentConditions(weatherData),
      hourly: processHourlyForecast(weatherData.days[0].hours),
      daily: processDailyForecast(weatherData.days.slice(0, 7))
    };

    res.json(responseData);
  } catch (error) {
    console.error('Error in /api/weather:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch weather data' });
  }
});

// API endpoint to subscribe for alerts
app.post('/api/subscribe', async (req, res) => {
  try {
    const { phoneNumber, district, city } = req.body;
    
    // Validate input
    if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    if (!district || !city) {
      return res.status(400).json({ error: 'District and city are required' });
    }

    // Check if already subscribed
    const existing = await Subscriber.findOne({ phoneNumber });
    if (existing) {
      return res.status(200).json({ 
        message: `You're already subscribed for ${existing.city}, ${existing.district}` 
      });
    }

    // Save to database
    const subscriber = new Subscriber({ phoneNumber, district, city });
    await subscriber.save();

    // Send confirmation SMS
    if (process.env.NODE_ENV !== 'test') {
      await twilioClient.messages.create({
        body: `You've subscribed to hourly weather alerts for ${city}, ${district}. Reply STOP to unsubscribe.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: `+91${phoneNumber}`
      });
    }

    res.status(201).json({ message: 'Subscription successful' });
  } catch (error) {
    console.error('Error in /api/subscribe:', error);
    res.status(500).json({ error: 'Subscription failed' });
  }
});

// API endpoint to unsubscribe
app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const result = await Subscriber.deleteOne({ phoneNumber });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ message: 'Unsubscribed successfully' });
  } catch (error) {
    console.error('Error in /api/unsubscribe:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Scheduled job to send hourly alerts
nodeCron.schedule('0 * * * *', async () => {
  try {
    console.log('Starting hourly alert job...');
    const subscribers = await Subscriber.find();
    
    for (const sub of subscribers) {
      try {
        const weatherData = await fetchWeatherData(`${sub.city},Tamil Nadu,India`);
        const current = weatherData.currentConditions;
        
        const message = `Weather alert for ${sub.city}: ${current.conditions}, ` +
          `Temp: ${current.temp}°F (feels like ${current.feelslike}°F), ` +
          `Humidity: ${current.humidity}%, Wind: ${current.windspeed} mph`;
        
        if (process.env.NODE_ENV !== 'test') {
          await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: `+91${sub.phoneNumber}`
          });
        }
        
        console.log(`Sent alert to ${sub.phoneNumber}`);
      } catch (error) {
        console.error(`Failed to send alert to ${sub.phoneNumber}:`, error);
      }
    }
    
    console.log(`Completed sending ${subscribers.length} alerts`);
  } catch (error) {
    console.error('Error in hourly alert job:', error);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app; // For testing